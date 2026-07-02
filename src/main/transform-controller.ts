// Orchestrator for highlight → transform → paste.
//
// Flow (Win+Alt+N pressed):
//   1. Refuse if F11 recording is in flight (single-flight policy).
//   2. Snapshot the user's current clipboard (text + html + rtf, OR image).
//   3. Simulate Ctrl+C (Cmd+C on darwin) to grab the highlighted selection.
//   4. Read the clipboard; if it didn't change → "highlight first" error.
//   5. Show overlay pill ("Transforming…").
//   6. POST to Groq with the command's system prompt.
//   7. Write the result to clipboard, Ctrl+V (replaces still-selected text).
//   8. Restore the original clipboard.
//   9. Hide overlay; broadcast transcription-complete for the dashboard feed.
//
// Single-flight via a Promise chain (same pattern as inject.ts).
// On error at any step: restore clipboard, broadcast transcription-error, hide overlay.

import { clipboard, BrowserWindow, NativeImage } from 'electron'
import log from 'electron-log/main'
import { getCommand } from './commands-store'
import { transformText } from './transform-llm'
import {
  getRecordingState,
  getPendingCommandId,
  startCommandRecording,
  stopRecording,
} from './recording-controller'
import { captureFocusTarget } from './inject'

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

const COPY_SETTLE_MS = 150
const PASTE_SETTLE_MS = 120

// The command hotkey (Ctrl+Shift+N) is usually still physically held when the
// handler fires. If we send Ctrl+C now, the still-held Shift turns it into
// Ctrl+Shift+C in the target app (devtools in browsers, nothing in most apps)
// — the copy silently fails and a real selection looks like "no selection".
// Synthetically releasing the modifiers makes the OS treat them as up even
// while the fingers are still on them.
async function releaseHotkeyModifiers(): Promise<void> {
  if (!nutKeyboard || !nutKey) return
  const mods = [
    nutKey.LeftShift, nutKey.RightShift,
    nutKey.LeftControl, nutKey.RightControl,
    nutKey.LeftAlt, nutKey.RightAlt,
    nutKey.LeftSuper, nutKey.RightSuper,
  ]
  for (const m of mods) {
    try {
      await nutKeyboard.releaseKey(m)
    } catch {
      // releasing an already-up key can throw on some platforms — ignore
    }
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

  // Step 1: Send Ctrl+C (Cmd+C on Mac) to grab the selection. Force-release
  // the still-held hotkey modifiers first or the copy arrives as Ctrl+Shift+C.
  await releaseHotkeyModifiers()
  await sleep(30)
  const modifier =
    process.platform === 'darwin' ? nutKey.LeftSuper : nutKey.LeftControl
  try {
    await nutKeyboard.pressKey(modifier, nutKey.C)
    await sleep(20)
    await nutKeyboard.releaseKey(modifier, nutKey.C)
  } catch (err) {
    log.error('[transform] copy keystroke failed', err)
    broadcast('transcription-error', 'Could not grab the selection.')
    return
  }

  await sleep(COPY_SETTLE_MS)
  const selected = clipboard.readText()

  // Empty / unchanged → nothing was highlighted. Instead of erroring, start
  // a command dictation: speak, press the hotkey again, and the transcript
  // is transformed by this command's prompt before pasting.
  if (!selected || selected === originalText) {
    log.info(`[transform] no selection — starting "${cmd.name}" dictation`)
    // Original clipboard wasn't actually changed; no restore needed.
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
      cmd.prompt,
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
  broadcast('transcription-complete', transformed)
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
