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

// ── Timing tunables (Fast Batch, work item F) ──────────────────────────────
// All env-overridable so a machine where a target app drops pastes (slow
// RDP session, ancient Delphi apps with lazy clipboard readers) can be
// loosened without a rebuild.
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}
// Delay between clipboard.writeText and the Ctrl+V keystroke. Electron's
// writeText is synchronous on Windows by the time it returns; this settle
// only covers clipboard-viewer chains / OLE delayed-render stragglers.
// 20 ms (was 50) held up in testing.
const CLIPBOARD_SETTLE_MS = envMs('SPEAKFLOW_INJECT_CLIPBOARD_SETTLE_MS', 20)
// Hold time between Ctrl+V key-down and key-up. 15 ms (was 30) — apps read
// the paste on WM_KEYDOWN; the hold only needs to outlive input coalescing.
const KEY_GAP_MS = envMs('SPEAKFLOW_INJECT_KEY_GAP_MS', 15)
// How long OUR text must stay on the clipboard after Ctrl+V before we
// restore the user's previous clipboard — the target app reads the clipboard
// when ITS message loop processes the paste, typically 10-80 ms after
// key-up. 120 ms gives ~3× headroom over typical Windows write-back latency
// (was 260 ms once — overly conservative). Since the fast-path restructure
// this settle runs DETACHED (see injectViaClipboard) and no longer adds to
// perceived stop→paste latency at all.
const PASTE_SETTLE_MS = envMs('SPEAKFLOW_INJECT_PASTE_SETTLE_MS', 120)
// Keystroke typing is DISABLED by default (limit 0): nut-js types character
// by character, which users see as stuttery "very fast typing" for short
// dictations while long ones paste atomically — inconsistent and slower than
// the clipboard fast path. Wispr pastes everything. The keystroke path stays
// as an env-enabled escape hatch for apps that block synthetic Ctrl+V
// (some VMs/Citrix): set SPEAKFLOW_INJECT_KEYSTROKE_MAX=100 to restore it.
const KEYSTROKE_LIMIT = envMs('SPEAKFLOW_INJECT_KEYSTROKE_MAX', 0)
// After releasing stray modifier keys, give the OS a beat to register the
// key-up events before we synthesize type()/Ctrl+V. Without this, the paste
// can still be interpreted with the modifier active. 60 ms is a safe margin
// on loaded systems (a native GetAsyncKeyState poll would be more precise but
// needs a native addon — overkill here). Since the fast-path restructure this
// overlaps the focus capture (Promise.all in doInject), so its cost is
// max(capture, release) rather than the sum.
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

// What doInject hands back: the caller-visible result plus (clipboard path
// only) the detached settle/restore tail that must finish before the NEXT
// injection may run.
interface InjectOutcome {
  result: InjectionResult
  settleTail?: Promise<void>
}

// Stage timings threaded from doInject into the clipboard path so the single
// '[timing] inject …' line carries the whole story.
interface InjectMarks {
  captureMs: number
  modifiersMs: number
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
      const { result, settleTail } = await doInject(text, expectedTarget)
      // Fast path: resolve the caller the moment the paste outcome is known —
      // for the clipboard path that is right after Ctrl+V key-up, ~120 ms
      // earlier than waiting for settle+restore. RACE RATIONALE for keeping
      // the tail INSIDE this mutex chain rather than truly fire-and-forget:
      // the target app reads the clipboard asynchronously after our key-up.
      // If a second injection (rapid back-to-back dictations) wrote its text
      // to the clipboard during this window, the FIRST paste could land the
      // SECOND dictation's text — silent data corruption. So the next queued
      // injection awaits this tail via injectionInFlight; only the current
      // caller is released early.
      resolveOuter(result)
      if (settleTail) {
        await settleTail.catch((err) => log.warn('inject settle tail failed', err))
      }
    } catch (err) {
      rejectOuter(err as Error)
    }
  })

  return outerPromise
}

async function doInject(
  text: string,
  expectedTarget: WindowSnapshot | null,
): Promise<InjectOutcome> {
  const nutReady = loadNut()
  if (!nutReady) {
    clipboard.writeText(text)
    return { result: { ok: false, method: 'clipboard-only', error: 'no-keyboard-backend' } }
  }

  // We DON'T abort if focus changed since the user pressed the hotkey.
  // Voice-to-text apps should paste into whichever window the user is in
  // RIGHT NOW — if they alt-tabbed mid-recording, they expect the text to
  // land in the new window.
  //
  // BUT: refuse to type into Speakflow itself — that would inject text into
  // our own dashboard. Also fail-closed if we can't identify the current
  // window AT ALL (and we never had an original target either).
  //
  // Fast path (work item F): the focus capture and the stray-modifier
  // release run CONCURRENTLY. They are independent OS operations — reading
  // the foreground window's identity doesn't consume input events, and
  // synthesizing modifier key-UPs can't change which window is foreground.
  // Serial cost was capture + (release + 60 ms settle); now it's
  // max(capture, release+settle). The only behavioral delta: modifiers get
  // released even when the checks below then refuse to paste — harmless,
  // we're only releasing keys the user is mid-way through letting go of
  // (their recording hotkey).
  const tParallel = Date.now()
  let captureMs = 0
  let modifiersMs = 0
  const [current] = await Promise.all([
    captureFocusTarget().then((snap) => {
      captureMs = Date.now() - tParallel
      return snap
    }),
    clearStrayModifiers().then(() => {
      modifiersMs = Date.now() - tParallel
    }),
  ])

  if (isLikelyOwnWindow(current)) {
    log.warn('Refusing to paste — Speakflow itself has focus.')
    clipboard.writeText(text)
    return { result: { ok: false, method: 'clipboard-only', error: 'self-window-focused' } }
  }
  if (!current && !expectedTarget) {
    log.warn('Refusing to paste — could not identify any target window.')
    clipboard.writeText(text)
    return { result: { ok: false, method: 'clipboard-only', error: 'no-target' } }
  }
  if (current && expectedTarget && current.title !== expectedTarget.title) {
    log.info(
      `Focus changed since hotkey press (was: ${expectedTarget.title}, now: ${current.title}) — pasting to current.`,
    )
  }

  if (KEYSTROKE_LIMIT > 0 && text.length <= KEYSTROKE_LIMIT && isPureAscii(text)) {
    try {
      const tType = Date.now()
      await nutKeyboard!.type(text)
      // Keystroke path has no clipboard/paste/settle stages — log its own
      // variant of the timing line so every injection still emits exactly one.
      log.info(
        `[timing] inject capture=${captureMs} modifiers=${modifiersMs} keystroke=${Date.now() - tType} method=keystroke`,
      )
      return { result: { ok: true, method: 'keystroke' } }
    } catch (err) {
      log.warn('Keystroke injection failed, falling back to clipboard', err)
    }
  }

  return injectViaClipboard(text, { captureMs, modifiersMs })
}

async function injectViaClipboard(text: string, marks: InjectMarks): Promise<InjectOutcome> {
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

  const tClipboard = Date.now()
  clipboard.writeText(text)
  await sleep(CLIPBOARD_SETTLE_MS)
  const clipboardMs = Date.now() - tClipboard

  const tPaste = Date.now()
  let pasteOk = false
  if (nutKeyboard && nutKey) {
    try {
      const modifier =
        process.platform === 'darwin' ? nutKey.LeftSuper : nutKey.LeftControl
      await nutKeyboard.pressKey(modifier, nutKey.V)
      await sleep(KEY_GAP_MS)
      await nutKeyboard.releaseKey(modifier, nutKey.V)
      pasteOk = true
    } catch (err) {
      log.error('Paste keystroke failed', err)
    }
  }
  const pasteMs = Date.now() - tPaste

  // Detached settle + clipboard restore. The paste outcome is fully decided
  // at this point — the settle exists only to keep OUR text on the clipboard
  // until the target app has read it (its message loop consumes the Ctrl+V
  // asynchronously), and the restore is pure cleanup. Neither should hold up
  // the caller's stop→paste latency, so the promise is returned to
  // injectText, which resolves the caller first and awaits this tail second
  // — still inside the injectionInFlight mutex (see the race rationale
  // there). The '[timing] inject' line is emitted at the END of the tail so
  // all five stage numbers are real, not projected.
  const settleTail = (async () => {
    const tSettle = Date.now()
    await sleep(PASTE_SETTLE_MS)
    // Restore as best we can. Compose multi-format when applicable so
    // RTF/HTML clipboards survive.
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
    log.info(
      `[timing] inject capture=${marks.captureMs} modifiers=${marks.modifiersMs} ` +
        `clipboard=${clipboardMs} paste=${pasteMs} settle=${Date.now() - tSettle}`,
    )
  })()

  return {
    result: pasteOk
      ? { ok: true, method: 'clipboard' }
      : { ok: false, method: 'clipboard', error: 'paste-failed' },
    settleTail,
  }
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
