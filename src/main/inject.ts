import { clipboard } from 'electron'
import log from 'electron-log/main'

// Type aliases — nut-js is loaded lazily.
type NutKeyboard = typeof import('@nut-tree-fork/nut-js')['keyboard']
type NutKey = typeof import('@nut-tree-fork/nut-js')['Key']
type NutGetActiveWindow = typeof import('@nut-tree-fork/nut-js')['getActiveWindow']

let nutKeyboard: NutKeyboard | null = null
let nutKey: NutKey | null = null
let nutGetActiveWindow: NutGetActiveWindow | null = null

// PIDs of our own renderer windows — set by main.ts after window creation
// so inject can refuse to type into the Speakflow window itself.
const ownWindowPids = new Set<number>()
export function registerOwnWindowPid(pid: number): void {
  if (typeof pid === 'number' && pid > 0) ownWindowPids.add(pid)
}
export function unregisterOwnWindowPid(pid: number): void {
  ownWindowPids.delete(pid)
}

function isLikelyOwnWindow(snapshot: WindowSnapshot | null): boolean {
  if (!snapshot) return false
  if (snapshot.pid !== null && ownWindowPids.has(snapshot.pid)) return true
  // Title-based fallback for platforms where nut-js doesn't expose pid.
  // Exact (case-insensitive) match for our app name — avoids false positives
  // from other apps that happen to mention "speakflow" in window title.
  const t = (snapshot.title ?? '').toLowerCase().trim()
  return t === 'speakflow'
}

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

// 120 ms gives ~3× headroom over typical Windows clipboard write-back
// latency. Was 260 ms — that was overly conservative and dominated the
// post-paste perceived delay.
const PASTE_SETTLE_MS = 120
const KEYSTROKE_LIMIT = 100
// After releasing stray modifier keys, give the OS a beat to register the
// key-up events before we synthesize type()/Ctrl+V. Without this, the paste
// can still be interpreted with the modifier active. 60 ms is a safe margin
// on loaded systems (a native GetAsyncKeyState poll would be more precise but
// needs a native addon — overkill here). Negligible vs the transcription RTT.
const MODIFIER_RELEASE_SETTLE_MS = 60

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
 * Pre-warm nut-js so the FIRST captureFocusTarget call after app start
 * doesn't pay the 3+ second cold-init penalty. Call from main.ts on app
 * ready. Safe to call multiple times — only successful runs flip the flag.
 *
 * Bounded to a 5s timeout. If the underlying nut-js call hangs past the
 * timeout, the background promise is allowed to continue (we can't cancel
 * native calls) but its result is ignored — `warmedUp` stays false so a
 * subsequent explicit warmup attempt is still allowed.
 */
let warmedUp = false
const WARMUP_TIMEOUT_MS = 5_000
export async function warmupInject(): Promise<void> {
  if (warmedUp) return
  let timedOut = false
  const doWarmup = async () => {
    loadNut()
    if (nutGetActiveWindow) {
      const w = await nutGetActiveWindow()
      try { await w.title } catch { /* ignore */ }
      try { await w.region } catch { /* ignore */ }
    }
    if (!timedOut) warmedUp = true
  }
  try {
    await Promise.race([
      doWarmup(),
      new Promise<void>((_resolve, reject) =>
        setTimeout(() => {
          timedOut = true
          reject(new Error('warmup-timeout'))
        }, WARMUP_TIMEOUT_MS),
      ),
    ])
  } catch (err) {
    log.warn('warmupInject did not complete in time — first F11 may be slow', err)
  }
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

  // We DON'T abort if focus changed since the user pressed the hotkey.
  // Voice-to-text apps should paste into whichever window the user is in
  // RIGHT NOW — if they alt-tabbed mid-recording, they expect the text to
  // land in the new window.
  //
  // BUT: refuse to type into Speakflow itself — that would inject text into
  // our own dashboard. Also fail-closed if we can't identify the current
  // window AT ALL (and we never had an original target either).
  const current = await captureFocusTarget()
  if (isLikelyOwnWindow(current)) {
    log.warn('Refusing to paste — Speakflow itself has focus.')
    clipboard.writeText(text)
    return { ok: false, method: 'clipboard-only', error: 'self-window-focused' }
  }
  if (!current && !expectedTarget) {
    log.warn('Refusing to paste — could not identify any target window.')
    clipboard.writeText(text)
    return { ok: false, method: 'clipboard-only', error: 'no-target' }
  }
  if (current && expectedTarget && current.title !== expectedTarget.title) {
    log.info(
      `Focus changed since hotkey press (was: ${expectedTarget.title}, now: ${current.title}) — pasting to current.`,
    )
  }

  // The recording hotkey may include modifiers (e.g. Ctrl+Shift+Space). If the
  // user is still holding them when we synthesize keystrokes, every typed char
  // becomes Ctrl+Shift+<char> (and Ctrl+V becomes Ctrl+Shift+V) — so nothing
  // lands. Proactively release stray modifiers first.
  await clearStrayModifiers()

  if (text.length <= KEYSTROKE_LIMIT && isPureAscii(text)) {
    try {
      await nutKeyboard!.type(text)
      return { ok: true, method: 'keystroke' }
    } catch (err) {
      log.warn('Keystroke injection failed, falling back to clipboard', err)
    }
  }

  return injectViaClipboard(text)
}

async function injectViaClipboard(text: string): Promise<InjectionResult> {
  // Snapshot previous clipboard so we can restore it after paste settles.
  // readImage() can be slow (5-50 ms) when the user has a large screenshot —
  // only call it when no text-ish format is present, since text/html/rtf
  // take precedence on restore anyway.
  const formats = clipboard.availableFormats()
  const hasTextish = formats.some(
    (f) => f.startsWith('text/') || f === 'public.utf8-plain-text',
  )
  const previousText = clipboard.readText()
  const previousHtml = clipboard.readHTML?.() ?? ''
  const previousRtf =
    (clipboard as unknown as { readRTF?: () => string }).readRTF?.() ?? ''
  const previousImage = hasTextish ? null : clipboard.readImage()

  clipboard.writeText(text)
  await sleep(50)

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
    } else if (previousImage && !previousImage.isEmpty()) {
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

/**
 * Send key-up for every modifier so a still-held recording hotkey (e.g.
 * Ctrl+Shift+Space) doesn't combine with the keystrokes we're about to
 * synthesize. Best-effort: each release is guarded, and we settle briefly so
 * the OS processes the key-ups before the subsequent type()/Ctrl+V.
 */
async function clearStrayModifiers(): Promise<void> {
  if (!nutKeyboard || !nutKey) return
  const modifiers = [
    nutKey.LeftControl,
    nutKey.RightControl,
    nutKey.LeftShift,
    nutKey.RightShift,
    nutKey.LeftAlt,
    nutKey.RightAlt,
    nutKey.LeftSuper,
    nutKey.RightSuper,
  ]
  for (const m of modifiers) {
    try {
      await nutKeyboard.releaseKey(m)
    } catch {
      // A modifier that wasn't down can throw on some backends — ignore.
    }
  }
  await sleep(MODIFIER_RELEASE_SETTLE_MS)
}

function isPureAscii(text: string): boolean {
  return /^[\x20-\x7E]+$/.test(text)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
