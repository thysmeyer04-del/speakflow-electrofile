import { clipboard } from 'electron'
import log from 'electron-log/main'

// Type aliases — nut-js is loaded lazily so its types aren't always available
// at module init.
type NutKeyboard = typeof import('@nut-tree-fork/nut-js')['keyboard']
type NutKey = typeof import('@nut-tree-fork/nut-js')['Key']
type NutGetActiveWindow = typeof import('@nut-tree-fork/nut-js')['getActiveWindow']

let nutKeyboard: NutKeyboard | null = null
let nutKey: NutKey | null = null
let nutGetActiveWindow: NutGetActiveWindow | null = null

function loadNut(): boolean {
  if (nutKeyboard) return true
  try {
    const nut = require('@nut-tree-fork/nut-js') as typeof import('@nut-tree-fork/nut-js')
    nutKeyboard = nut.keyboard
    nutKey = nut.Key
    nutGetActiveWindow = nut.getActiveWindow
    nutKeyboard.config.autoDelayMs = 0
    return true
  } catch (err) {
    log.warn('nut-js load failed; injection disabled', err)
    return false
  }
}

const FOCUS_RETURN_DELAY_MS = 180
const PASTE_SETTLE_MS = 260
const KEYSTROKE_LIMIT = 100

// Process-wide mutex — clipboard injection cannot interleave.
let injectionInFlight: Promise<void> = Promise.resolve()

export interface InjectionResult {
  ok: boolean
  method: 'keystroke' | 'clipboard' | 'clipboard-only'
  error?: string
}

export async function injectText(text: string): Promise<InjectionResult> {
  if (!text) return { ok: true, method: 'keystroke' }

  // Serialize: chain onto whatever is currently running.
  let resolveOuter!: (r: InjectionResult) => void
  let rejectOuter!: (e: Error) => void
  const outerPromise = new Promise<InjectionResult>((res, rej) => {
    resolveOuter = res
    rejectOuter = rej
  })

  injectionInFlight = injectionInFlight.then(async () => {
    try {
      const r = await doInject(text)
      resolveOuter(r)
    } catch (err) {
      rejectOuter(err as Error)
    }
  })

  return outerPromise
}

async function doInject(text: string): Promise<InjectionResult> {
  await sleep(FOCUS_RETURN_DELAY_MS)
  const nutReady = loadNut()

  if (!nutReady) {
    // No keystroke backend — leave the text on the clipboard so the user
    // can paste manually. Surface this so callers can show an error.
    clipboard.writeText(text)
    return {
      ok: false,
      method: 'clipboard-only',
      error: 'no-keyboard-backend',
    }
  }

  // Capture the foreground window. We re-check immediately before paste to
  // guard against focus-stealing during the typing delay.
  const targetSnapshot = await snapshotActiveWindow()

  if (text.length <= KEYSTROKE_LIMIT && isPureAscii(text)) {
    try {
      await nutKeyboard!.type(text)
      return { ok: true, method: 'keystroke' }
    } catch (err) {
      log.warn('Keystroke injection failed, falling back to clipboard', err)
    }
  }

  return injectViaClipboard(text, targetSnapshot)
}

interface WindowSnapshot {
  title: string | null
}

async function snapshotActiveWindow(): Promise<WindowSnapshot | null> {
  if (!nutGetActiveWindow) return null
  try {
    const w = await nutGetActiveWindow()
    const title = await w.title
    return { title }
  } catch {
    return null
  }
}

async function injectViaClipboard(
  text: string,
  before: WindowSnapshot | null,
): Promise<InjectionResult> {
  const previousText = clipboard.readText()
  const previousImage = clipboard.readImage()
  const previousHtml = clipboard.readHTML?.() ?? ''
  const previousRtf = (clipboard as unknown as { readRTF?: () => string }).readRTF?.() ?? ''

  clipboard.writeText(text)
  await sleep(50)

  // Verify the foreground window is still the one we snapshotted. If focus
  // got stolen, abort the paste — leave the text on the clipboard so the
  // user can paste manually.
  if (before) {
    const after = await snapshotActiveWindow()
    if (after && after.title !== before.title) {
      log.warn(`Active window changed (${before.title} → ${after.title}); skipping paste`)
      // Don't restore clipboard — let user paste manually.
      return {
        ok: false,
        method: 'clipboard',
        error: 'focus-lost',
      }
    }
  }

  let pasteOk = false
  if (nutKeyboard && nutKey) {
    try {
      const modifier = process.platform === 'darwin' ? nutKey.LeftSuper : nutKey.LeftControl
      await nutKeyboard.pressKey(modifier, nutKey.V)
      await sleep(30)
      await nutKeyboard.releaseKey(modifier, nutKey.V)
      pasteOk = true
    } catch (err) {
      log.error('Paste keystroke failed', err)
    }
  }

  // Wait for the target app to consume the clipboard before we restore.
  await sleep(PASTE_SETTLE_MS)

  // Restore as best we can. Order: HTML+text > image > text > nothing.
  try {
    if (previousHtml) {
      clipboard.write({
        text: previousText,
        html: previousHtml,
        ...(previousRtf ? { rtf: previousRtf } : {}),
      })
    } else if (!previousImage.isEmpty()) {
      clipboard.writeImage(previousImage)
    } else if (previousText.length > 0) {
      clipboard.writeText(previousText)
    }
  } catch (err) {
    log.warn('Clipboard restore failed', err)
  }

  if (!pasteOk) {
    return { ok: false, method: 'clipboard', error: 'paste-failed' }
  }
  return { ok: true, method: 'clipboard' }
}

function isPureAscii(text: string): boolean {
  // Printable ASCII only — no newlines/tabs which the keystroke path mangles.
  return /^[\x20-\x7E]+$/.test(text)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
