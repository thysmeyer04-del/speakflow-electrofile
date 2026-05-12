import { clipboard } from 'electron'
import log from 'electron-log/main'

// Type aliases — nut-js is loaded lazily.
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
let injectionInFlight: Promise<unknown> = Promise.resolve()

export interface WindowSnapshot {
  title: string
  region: string | null // serialized region as a fingerprint; null when unavailable
  processName: string | null
  pid: number | null
}

export interface InjectionResult {
  ok: boolean
  method: 'keystroke' | 'clipboard' | 'clipboard-only'
  error?: string
}

/**
 * Capture the foreground window. Call this AT THE MOMENT the user expressed
 * intent (hotkey press) — *before* any audio/transcription work — and pass
 * the snapshot to injectText. Returns null if nut-js cannot give us strong
 * enough identity to verify safely.
 */
export async function captureFocusTarget(): Promise<WindowSnapshot | null> {
  if (!loadNut() || !nutGetActiveWindow) return null
  try {
    const w = (await nutGetActiveWindow()) as unknown as {
      title: Promise<string> | string
      region: Promise<unknown> | unknown
      processName?: Promise<string> | string
      pid?: Promise<number> | number
    }
    const [title, region, processName, pid] = await Promise.all([
      Promise.resolve(w.title),
      Promise.resolve(w.region),
      w.processName ? Promise.resolve(w.processName) : Promise.resolve<string | null>(null),
      w.pid ? Promise.resolve(w.pid) : Promise.resolve<number | null>(null),
    ])
    let fingerprint: string | null = null
    if (region && typeof region === 'object') {
      const r = region as { left?: number; top?: number; width?: number; height?: number }
      if (
        typeof r.left === 'number' &&
        typeof r.top === 'number' &&
        typeof r.width === 'number' &&
        typeof r.height === 'number'
      ) {
        fingerprint = `${r.left}x${r.top}+${r.width}+${r.height}`
      }
    }

    const t = (title ?? '').toString()
    // Fail-closed: a window we can't strongly identify is rejected. We need
    // at least pid, or processName, or (title AND region) — any weaker than
    // that and snapshotsMatch would happily compare two empty/unknown values.
    const hasStrongId = typeof pid === 'number' || !!processName
    const hasTitleRegion = !!t && !!fingerprint
    if (!hasStrongId && !hasTitleRegion) return null

    return {
      title: t,
      region: fingerprint,
      processName: processName ? String(processName) : null,
      pid: typeof pid === 'number' ? pid : null,
    }
  } catch (err) {
    log.warn('captureFocusTarget failed', err)
    return null
  }
}

function snapshotsMatch(a: WindowSnapshot | null, b: WindowSnapshot | null): boolean {
  if (!a || !b) return false

  // Identity strength asymmetry is suspicious — if one snapshot has pid/
  // processName but the other doesn't, the active window changed underneath.
  if ((a.pid === null) !== (b.pid === null)) return false
  if ((a.processName === null) !== (b.processName === null)) return false

  // Helper: a secondary match requires non-empty, equal values — null/empty
  // never counts.
  const titlesMatch = !!a.title && a.title === b.title
  const regionsMatch = !!a.region && a.region === b.region

  // pid + a window discriminator (multiple windows can share a pid).
  if (a.pid !== null && b.pid !== null) {
    if (a.pid !== b.pid) return false
    return titlesMatch || regionsMatch
  }

  // processName + (title OR region).
  if (a.processName && b.processName) {
    if (a.processName !== b.processName) return false
    return titlesMatch || regionsMatch
  }

  // Title+region only — both must be non-empty AND BOTH must match.
  // This is the weakest path (no pid/processName from nut-js on this platform).
  return titlesMatch && regionsMatch
}

export async function injectText(
  text: string,
  expectedTarget: WindowSnapshot | null,
): Promise<InjectionResult> {
  // Callers should never pass empty text — this is a defensive guard. Return
  // a non-success result so the caller can't misread it as a successful paste.
  if (!text) return { ok: false, method: 'keystroke', error: 'empty-input' }

  let resolveOuter!: (r: InjectionResult) => void
  let rejectOuter!: (e: Error) => void
  const outerPromise = new Promise<InjectionResult>((res, rej) => {
    resolveOuter = res
    rejectOuter = rej
  })

  injectionInFlight = injectionInFlight.then(async () => {
    try {
      const r = await doInject(text, expectedTarget)
      resolveOuter(r)
    } catch (err) {
      rejectOuter(err as Error)
    }
  })

  return outerPromise
}

async function doInject(
  text: string,
  expectedTarget: WindowSnapshot | null,
): Promise<InjectionResult> {
  const nutReady = loadNut()
  if (!nutReady) {
    clipboard.writeText(text)
    return { ok: false, method: 'clipboard-only', error: 'no-keyboard-backend' }
  }

  // Fail-closed: if we cannot verify identity, do NOT paste — too risky.
  if (!expectedTarget) {
    clipboard.writeText(text)
    return { ok: false, method: 'clipboard-only', error: 'no-target-snapshot' }
  }

  // Verify focus BEFORE the focus-return delay so we don't paste into a
  // window that stole focus during the wait.
  const beforeDelay = await captureFocusTarget()
  if (!snapshotsMatch(beforeDelay, expectedTarget)) {
    log.warn(
      `Focus changed before paste (expected: ${expectedTarget.title}, actual: ${beforeDelay?.title ?? 'unknown'})`,
    )
    clipboard.writeText(text)
    return { ok: false, method: 'clipboard-only', error: 'focus-lost' }
  }

  await sleep(FOCUS_RETURN_DELAY_MS)

  // Re-check focus after the delay too.
  const afterDelay = await captureFocusTarget()
  if (!snapshotsMatch(afterDelay, expectedTarget)) {
    log.warn(
      `Focus changed during delay (expected: ${expectedTarget.title}, actual: ${afterDelay?.title ?? 'unknown'})`,
    )
    clipboard.writeText(text)
    return { ok: false, method: 'clipboard-only', error: 'focus-lost' }
  }

  if (text.length <= KEYSTROKE_LIMIT && isPureAscii(text)) {
    // One last focus check immediately before typing.
    const right = await captureFocusTarget()
    if (!snapshotsMatch(right, expectedTarget)) {
      clipboard.writeText(text)
      return { ok: false, method: 'clipboard-only', error: 'focus-lost' }
    }
    try {
      await nutKeyboard!.type(text)
      return { ok: true, method: 'keystroke' }
    } catch (err) {
      log.warn('Keystroke injection failed, falling back to clipboard', err)
    }
  }

  return injectViaClipboard(text, expectedTarget)
}

async function injectViaClipboard(
  text: string,
  expectedTarget: WindowSnapshot,
): Promise<InjectionResult> {
  const previousText = clipboard.readText()
  const previousImage = clipboard.readImage()
  const previousHtml = clipboard.readHTML?.() ?? ''
  const previousRtf =
    (clipboard as unknown as { readRTF?: () => string }).readRTF?.() ?? ''

  clipboard.writeText(text)
  await sleep(50)

  // Final focus check immediately before sending paste.
  const right = await captureFocusTarget()
  if (!snapshotsMatch(right, expectedTarget)) {
    log.warn(`Focus changed at paste moment (was: ${right?.title})`)
    return { ok: false, method: 'clipboard', error: 'focus-lost' }
  }

  let pasteOk = false
  if (nutKeyboard && nutKey) {
    try {
      const modifier =
        process.platform === 'darwin' ? nutKey.LeftSuper : nutKey.LeftControl
      await nutKeyboard.pressKey(modifier, nutKey.V)
      await sleep(30)
      await nutKeyboard.releaseKey(modifier, nutKey.V)
      pasteOk = true
    } catch (err) {
      log.error('Paste keystroke failed', err)
    }
  }

  await sleep(PASTE_SETTLE_MS)

  // Restore as best we can. Compose multi-format when applicable so RTF/HTML
  // clipboards survive.
  try {
    const compose: { text?: string; html?: string; rtf?: string } = {}
    if (previousText) compose.text = previousText
    if (previousHtml) compose.html = previousHtml
    if (previousRtf) compose.rtf = previousRtf
    if (Object.keys(compose).length > 0) {
      clipboard.write(compose)
    } else if (!previousImage.isEmpty()) {
      clipboard.writeImage(previousImage)
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
  return /^[\x20-\x7E]+$/.test(text)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
