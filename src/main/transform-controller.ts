// Orchestrator for highlight → transform → paste.
//
// Flow (Ctrl+Shift+N pressed):
//   1. Refuse if F11 recording is in flight (single-flight policy).
//   2. Snapshot the user's current clipboard (text + html + rtf, OR image).
//   3. Write a unique SENTINEL to the clipboard, clear stray modifiers,
//      simulate Ctrl+C (Cmd+C on darwin) to grab the highlighted selection.
//   4. Poll the clipboard: changed away from the sentinel → that's the
//      selection; still the sentinel after retry → no selection → restore
//      clipboard and start a command dictation instead ("speak an email").
//   5. Show overlay pill ("Transforming…").
//   6. POST to Groq with the command's system prompt (+ tone).
//   7. Write the result to clipboard, Ctrl+V (replaces still-selected text).
//   8. Restore the original clipboard.
//   9. Hide overlay; broadcast transcription-complete for the dashboard feed.
//
// Single-flight via a Promise chain (same pattern as inject.ts).
// On error at any step: restore clipboard, broadcast transcription-error, hide overlay.

import { clipboard, BrowserWindow, NativeImage } from 'electron'
import log from 'electron-log/main'
import { getCommand, toneInstruction } from './commands-store'
import { transformText } from './transform-llm'
import {
  getRecordingState,
  getPendingCommandId,
  startCommandRecording,
  stopRecording,
} from './recording-controller'
import { captureFocusTarget, clearStrayModifiers } from './inject'

type NutKeyboard = typeof import('@nut-tree-fork/nut-js')['keyboard']
type NutKey = typeof import('@nut-tree-fork/nut-js')['Key']

let nutKeyboard: NutKeyboard | null = null
let nutKey: NutKey | null = null

function loadNut(): boolean {
  if (nutKeyboard) return true
  try {
    const nut = require('@nut-tree-fork/nut-js') as typeof import('@nut-tree-fork/nut-js')
    nutKeyboard = nut.keyboard
    nutKey = nut.Key
    nutKeyboard.config.autoDelayMs = 0
    return true
  } catch (err) {
    log.warn('[transform] nut-js load failed; transforms disabled', err)
    return false
  }
}

let transformChain: Promise<void> = Promise.resolve()
let currentAbort: AbortController | null = null

function broadcast(channel: string, payload?: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

const PASTE_SETTLE_MS = 120

// ── Selection detection (v0.6.0 rewrite) ────────────────────────────────────
// The old detector did ONE clipboard read 150 ms after the synthetic Ctrl+C
// and compared it to the pre-copy clipboard. Three real-world failures
// (observed as "pressed Ctrl+Shift+1 with a selection → app started
// Listening", 2026-07-16):
//   1. Only a 30 ms modifier settle — the still-physically-held Ctrl+Shift
//      turned the copy into Ctrl+Shift+C (DevTools in browsers, no copy).
//      → now uses inject.ts's clearStrayModifiers (all 8 modifiers + 60 ms),
//        the same routine the paste path has trusted for months.
//   2. Slow Chromium/Electron targets missed the fixed 150 ms window.
//      → now a 25 ms poll up to 400 ms, with ONE retry Ctrl+C after that.
//   3. A selection identical to the old clipboard read as "no selection".
//      → now a unique SENTINEL is written first; ANY change away from the
//        sentinel is a successful copy — even re-copying identical text.
const COPY_POLL_INTERVAL_MS = 25
const COPY_POLL_TIMEOUT_MS = 400
const COPY_RETRY_TIMEOUT_MS = 250

/** Poll the clipboard until it no longer holds the sentinel (→ copied text)
 *  or the timeout lapses (→ no selection / copy failed). */
async function pollClipboardChange(sentinel: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const now = clipboard.readText()
    if (now !== sentinel) return now
    if (Date.now() >= deadline) return null
    await sleep(COPY_POLL_INTERVAL_MS)
  }
}

export function runTransform(commandId: string): Promise<void> {
  const next = transformChain.then(() => doRunTransform(commandId))
  transformChain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

// Command hotkey entry point (Ctrl+Shift+N). Two behaviors:
//  - Text highlighted → transform the selection in place (classic flow).
//  - Nothing highlighted → start a dictation; the transcript is run through
//    the command's prompt before pasting ("speak an email"). Pressing the
//    same hotkey again stops the dictation.
export function handleCommandHotkey(commandId: string): Promise<void> {
  const state = getRecordingState()
  if (state === 'recording' && getPendingCommandId() === commandId) {
    return stopRecording()
  }
  if (state !== 'idle') {
    broadcast('recording-busy', state)
    return Promise.resolve()
  }
  return runTransform(commandId)
}

/** Called by the recording controller when F11 fires mid-transform. */
export function abortInFlightTransform(): void {
  currentAbort?.abort()
}

async function doRunTransform(commandId: string): Promise<void> {
  if (getRecordingState() !== 'idle') {
    log.info('[transform] refused — recording in progress')
    broadcast('transcription-error', 'Finish your recording first.')
    return
  }

  const cmd = getCommand(commandId)
  if (!cmd) {
    log.warn(`[transform] unknown command id: ${commandId}`)
    return
  }

  if (!loadNut() || !nutKeyboard || !nutKey) {
    broadcast('transcription-error', 'Keyboard backend unavailable.')
    return
  }

  // Snapshot original clipboard contents for restore at the end.
  const clipFormats = clipboard.availableFormats()
  const hasTextish = clipFormats.some(
    (f) => f.startsWith('text/') || f === 'public.utf8-plain-text',
  )
  const originalText = clipboard.readText()
  const originalHtml = clipboard.readHTML?.() ?? ''
  const originalRtf =
    (clipboard as unknown as { readRTF?: () => string }).readRTF?.() ?? ''
  const originalImage: NativeImage | null = hasTextish
    ? null
    : clipboard.readImage()

  // Focus capture so logs help debug self-paste / wrong-window issues.
  const focusTarget = await captureFocusTarget()
  log.info(
    `[transform] command="${cmd.name}" target=${focusTarget?.title ?? '(unknown)'}`,
  )

  // Step 1: Grab the selection via synthetic Ctrl+C (Cmd+C on Mac).
  // Sentinel first: whatever the clipboard holds afterward that ISN'T the
  // sentinel is the copied selection — detection no longer depends on the
  // selection differing from the user's previous clipboard content.
  const sentinel = `​[speakflow:probe:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}]`
  clipboard.writeText(sentinel)

  // Release the still-physically-held hotkey modifiers with the SAME routine
  // the paste path uses (all 8 modifiers + 60 ms settle). The old local
  // variant settled only 30 ms and real selections read as "no selection".
  await clearStrayModifiers()
  const modifier =
    process.platform === 'darwin' ? nutKey.LeftSuper : nutKey.LeftControl

  const sendCopy = async (): Promise<boolean> => {
    try {
      await nutKeyboard!.pressKey(modifier, nutKey!.C)
      await sleep(20)
      await nutKeyboard!.releaseKey(modifier, nutKey!.C)
      return true
    } catch (err) {
      log.error('[transform] copy keystroke failed', err)
      return false
    }
  }

  let selected: string | null = null
  if (await sendCopy()) {
    selected = await pollClipboardChange(sentinel, COPY_POLL_TIMEOUT_MS)
    if (selected === null) {
      // Slow target may have swallowed the first chord — one retry.
      selected = (await sendCopy())
        ? await pollClipboardChange(sentinel, COPY_RETRY_TIMEOUT_MS)
        : null
    }
  }

  // No change (timeout) or a copy that produced empty text (e.g. an image
  // selection) → treat as "nothing highlighted": restore the user's
  // clipboard (the sentinel is on it!) and start a command dictation —
  // speak, press the hotkey again, transcript runs through this command.
  if (!selected || !selected.trim()) {
    restoreClipboard(originalText, originalHtml, originalRtf, originalImage)
    log.info(`[transform] no selection — starting "${cmd.name}" dictation`)
    await startCommandRecording(cmd.id)
    return
  }

  // Step 2: Show "Transforming…" pill via dedicated event.
  broadcast('transform-starting')

  // Step 3: LLM call.
  let transformed: string
  currentAbort = new AbortController()
  try {
    transformed = await transformText(
      cmd.prompt + toneInstruction(cmd.tone),
      selected,
      cmd.model,
      currentAbort.signal,
    )
  } catch (err) {
    log.error('[transform] LLM call failed', err)
    broadcast('transcription-error', (err as Error).message || 'Transform failed.')
    broadcast('processing-complete')
    restoreClipboard(originalText, originalHtml, originalRtf, originalImage)
    return
  } finally {
    currentAbort = null
  }

  // Step 4: Write result to clipboard, Ctrl+V to replace selection.
  clipboard.writeText(transformed)
  await sleep(30)

  try {
    await nutKeyboard.pressKey(modifier, nutKey.V)
    await sleep(20)
    await nutKeyboard.releaseKey(modifier, nutKey.V)
  } catch (err) {
    log.error('[transform] paste keystroke failed', err)
    broadcast(
      'transcription-error',
      'Paste failed. The transformed text is on your clipboard — press Ctrl+V manually.',
    )
    broadcast('processing-complete')
    // Don't restore clipboard — user needs the result to paste manually.
    return
  }

  await sleep(PASTE_SETTLE_MS)

  // Step 5: Restore original clipboard and hide overlay.
  restoreClipboard(originalText, originalHtml, originalRtf, originalImage)
  broadcast('transcription-complete', {
    text: transformed,
    // Transforms have no recording — duration is always 0.
    durationSeconds: 0,
    appName: focusTarget?.processName ?? null,
    windowTitle: focusTarget?.title ?? null,
    source: 'transform',
  })
  broadcast('processing-complete')
}

function restoreClipboard(
  text: string,
  html: string,
  rtf: string,
  image: NativeImage | null,
): void {
  try {
    const compose: { text?: string; html?: string; rtf?: string } = {}
    if (text) compose.text = text
    if (html) compose.html = html
    if (rtf) compose.rtf = rtf
    if (Object.keys(compose).length > 0) {
      clipboard.write(compose)
    } else if (image && !image.isEmpty()) {
      clipboard.writeImage(image)
    }
  } catch (err) {
    log.warn('[transform] clipboard restore failed', err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
