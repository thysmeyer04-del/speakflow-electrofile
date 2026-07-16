// Lifecycle owner for the hidden recorder BrowserWindow.

import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron'
import path from 'path'
import log from 'electron-log/main'

const READY_TIMEOUT_MS = 8_000
const START_TIMEOUT_MS = 5_000
const STOP_TIMEOUT_MS = 10_000
// On-demand PCM decode is only exercised by the rare cloud-unreachable →
// local-Whisper fallback; a hung decode must not hang that fallback forever.
const DECODE_PCM_TIMEOUT_MS = 15_000

// needPcm: recorder decodes the blob to 16 kHz PCM at stop time ONLY when the
// session will actually feed on-device Whisper (local transcription mode).
// streamPcm: recorder ALSO taps the mic through an AudioWorklet and ships
// live 50 ms int16 PCM frames up for the True Streaming (Deepgram) path.
// The MediaRecorder keeps recording regardless — streaming is an overlay on
// the batch pipeline, never a replacement.
interface StartPayload { microphoneId: string; needPcm?: boolean; streamPcm?: boolean }
interface BlobPayload {
  buffer: ArrayBuffer
  mimeType: string
  pcm?: ArrayBuffer | null
  speechMs?: number | null
  peakLevel?: number | null
}

export interface RecorderResult {
  audio: Buffer
  // 16 kHz mono Float32 PCM decoded by the renderer — input for on-device
  // Whisper. Null when decode failed, was skipped (cloud mode), or the clip
  // was dropped (silence/short).
  pcm: Float32Array | null
  // Speech-energy stats from the renderer's level monitor. null = the level
  // monitor never ran, so callers MUST fail open (no speech gating).
  speechMs: number | null
  peakLevel: number | null
}

let recorderWindow: BrowserWindow | null = null
let readyPromise: Promise<void> | null = null
let readyResolved = false
let expectingClose = false
let crashHandlers: Array<(reason: string) => void> = []
let autoStopHandlers: Array<() => void> = []
// Where to forward live audio levels. Set once at startup by main.ts.
let levelTargetWindow: BrowserWindow | null = null

// ── True Streaming PCM plumbing ─────────────────────────────────────────────
// Single registered callback (not a handler array like crash/autoStop):
// exactly one recording session can own the PCM tap at a time, and the
// recording-controller swaps the callback per session with a closure that
// carries its session id. Null = drop frames on the floor (no active stream).
let pcmFrameHandler: ((frame: Buffer) => void) | null = null
let pcmUnavailableHandler: ((reason: string) => void) | null = null
// A 50 ms frame @16 kHz int16 is exactly 1,600 bytes; cap well above that so
// a misbehaving renderer can't shovel megabytes per message through IPC.
const MAX_PCM_FRAME_BYTES = 8_192

/** Set (or clear, with null) the per-session consumer of live PCM frames. */
export function setPcmFrameHandler(cb: ((frame: Buffer) => void) | null): void {
  pcmFrameHandler = cb
}

/** Set (or clear) the callback for the renderer declaring it cannot stream
 *  PCM this session (16 kHz context refused, worklet load failed, …). The
 *  recording itself continues — only the streaming overlay is off. */
export function setPcmUnavailableHandler(cb: ((reason: string) => void) | null): void {
  pcmUnavailableHandler = cb
}

// Pending on-demand PCM decode round-trips, keyed by request id. Resolved
// with null on timeout / crash / malformed reply — never rejected, so the
// local-fallback caller can simply treat null as "no PCM available".
interface PendingDecode {
  resolve: (pcm: Float32Array | null) => void
  timer: NodeJS.Timeout
}
let decodeSeq = 0
const pendingDecodes = new Map<number, PendingDecode>()

interface PendingStart {
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}
interface PendingStop {
  resolve: (result: RecorderResult) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

let pendingStart: PendingStart | null = null
let pendingStop: PendingStop | null = null

// ── Public API ─────────────────────────────────────────────────────────────
export function initRecorder(): void {
  if (recorderWindow && !recorderWindow.isDestroyed()) return

  expectingClose = false
  readyResolved = false
  const isDev = process.env.NODE_ENV === 'development'
  recorderWindow = new BrowserWindow({
    // Tiny in prod (hidden); slightly bigger in dev so devtools is usable.
    width: isDev ? 600 : 1,
    height: isDev ? 400 : 1,
    show: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'recorder', 'recorder-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  const win = recorderWindow

  // Forward renderer console output to main's log so failures in the hidden
  // window aren't invisible.
  win.webContents.on('console-message', (_e, level, message, line, src) => {
    const lvl = ['debug', 'info', 'warn', 'error'][level] ?? 'info'
    log.info(`[recorder-renderer:${lvl}] ${message} (${src}:${line})`)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    handleCrash(`render-process-gone: ${details.reason}`)
  })
  win.webContents.on('unresponsive', () => {
    log.warn('[recorder] window unresponsive')
  })
  win.on('closed', () => {
    const wasExpected = expectingClose
    if (recorderWindow === win) recorderWindow = null
    if (!wasExpected) handleCrash('window-closed')
  })

  readyPromise = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      // Sticky-reject avoidance: clear the cached promise so the next start
      // attempt forces a fresh recorder init.
      readyPromise = null
      reject(new Error('ready-timeout'))
    }, READY_TIMEOUT_MS)
    win.webContents.once('did-finish-load', () => {
      clearTimeout(t)
      readyResolved = true
      resolve()
    })
    win.webContents.once('did-fail-load', (_e, _code, desc) => {
      clearTimeout(t)
      readyPromise = null
      reject(new Error(`recorder-load-failed: ${desc}`))
    })
  })

  win.loadFile(path.join(__dirname, '..', 'recorder', 'recorder.html')).catch((err) => {
    log.error('[recorder] loadFile threw', err)
  })

  registerHandlers()
}

export function destroyRecorder(): void {
  expectingClose = true
  rejectPending('shutdown')
  flushPendingDecodes()
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.destroy()
  }
  recorderWindow = null
  readyPromise = null
  readyResolved = false
}

export function isRecorderHealthy(): boolean {
  return recorderWindow !== null && !recorderWindow.isDestroyed()
}

export function onRecorderCrash(cb: (reason: string) => void): () => void {
  crashHandlers.push(cb)
  return () => {
    crashHandlers = crashHandlers.filter((h) => h !== cb)
  }
}

export function onAutoStop(cb: () => void): () => void {
  autoStopHandlers.push(cb)
  return () => {
    autoStopHandlers = autoStopHandlers.filter((h) => h !== cb)
  }
}

/** Where to forward live audio levels — typically the overlay window. */
export function setLevelTargetWindow(win: BrowserWindow | null): void {
  levelTargetWindow = win
}

/** Fire-and-forget: pre-acquires the mic stream so first F11 skips getUserMedia. */
export function warmupRecorderMic(microphoneId: string): void {
  if (!recorderWindow || recorderWindow.isDestroyed()) return
  try {
    recorderWindow.webContents.send('recorder:warmup', { microphoneId })
  } catch {
    // best-effort, never crash over warmup
  }
}

export async function startRecorderSession(opts: StartPayload): Promise<void> {
  // Lazy (re-)init: if the window doesn't exist (first start, crashed, or
  // destroyed), spin it up fresh.
  if (!recorderWindow || recorderWindow.isDestroyed()) {
    initRecorder()
  }
  if (!recorderWindow) throw new Error('recorder-init')

  // Wait for renderer ready. If the existing promise has been cleared (e.g.
  // a previous timeout), the lazy init above gave us a fresh one.
  if (readyPromise && !readyResolved) {
    await readyPromise
  }

  if (pendingStart) throw new Error('start-already-pending')

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStart = null
      reject(new Error('start-timeout'))
    }, START_TIMEOUT_MS)
    pendingStart = { resolve, reject, timer }
    try {
      recorderWindow!.webContents.send('recorder:start', opts)
    } catch (err) {
      clearTimeout(timer)
      pendingStart = null
      reject(err as Error)
    }
  })
}

export async function stopRecorderSession(): Promise<RecorderResult> {
  if (!recorderWindow) throw new Error('recorder-missing')
  if (pendingStop) throw new Error('stop-already-pending')

  return new Promise<RecorderResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStop = null
      reject(new Error('stop-timeout'))
    }, STOP_TIMEOUT_MS)
    pendingStop = { resolve, reject, timer }
    try {
      recorderWindow!.webContents.send('recorder:stop')
    } catch (err) {
      clearTimeout(timer)
      pendingStop = null
      reject(err as Error)
    }
  })
}

/** On-demand decode of a compressed clip to 16 kHz mono PCM, performed by the
 *  recorder window (main has no Web Audio). Fail-open by design: resolves
 *  null on missing window, timeout, crash, or decode failure — the caller
 *  (cloud-unreachable → local Whisper fallback in transcribe.ts) treats null
 *  as "local path unavailable" and surfaces the original cloud error. */
export function decodePcmViaRecorder(audio: Buffer): Promise<Float32Array | null> {
  if (!recorderWindow || recorderWindow.isDestroyed() || audio.byteLength === 0) {
    return Promise.resolve(null)
  }
  const id = ++decodeSeq
  return new Promise<Float32Array | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingDecodes.delete(id)
      log.warn(`[recorder] decode-pcm ${id} timed out after ${DECODE_PCM_TIMEOUT_MS}ms`)
      resolve(null)
    }, DECODE_PCM_TIMEOUT_MS)
    pendingDecodes.set(id, { resolve, timer })
    try {
      // Copy out of the Buffer pool: a pooled Buffer's backing ArrayBuffer is
      // shared with unrelated data, so slice to exactly this clip's bytes
      // before handing it to the structured-clone IPC serializer.
      const payload = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)
      recorderWindow!.webContents.send('recorder:decode-pcm', { id, buffer: payload })
    } catch (err) {
      clearTimeout(timer)
      pendingDecodes.delete(id)
      log.warn('[recorder] decode-pcm send failed', err)
      resolve(null)
    }
  })
}

/** Resolve (with null) every in-flight decode — crash/shutdown path. */
function flushPendingDecodes(): void {
  for (const [, p] of pendingDecodes) {
    clearTimeout(p.timer)
    p.resolve(null)
  }
  pendingDecodes.clear()
}

// ── IPC ────────────────────────────────────────────────────────────────────
let handlersRegistered = false
function registerHandlers() {
  if (handlersRegistered) return
  handlersRegistered = true

  ipcMain.on('recorder:started', (event) => {
    if (!isFromRecorder(event)) return
    if (!pendingStart) return
    clearTimeout(pendingStart.timer)
    pendingStart.resolve()
    pendingStart = null
  })

  ipcMain.on('recorder:failed', (event, message: string) => {
    if (!isFromRecorder(event)) return
    const sanitized = typeof message === 'string' ? message.slice(0, 200) : 'unknown'
    log.warn('[recorder] failed:', sanitized)

    if (pendingStart) {
      clearTimeout(pendingStart.timer)
      pendingStart.reject(new Error(sanitized))
      pendingStart = null
    } else if (pendingStop) {
      clearTimeout(pendingStop.timer)
      pendingStop.reject(new Error(sanitized))
      pendingStop = null
    }
  })

  ipcMain.handle(
    'recorder:audio-blob',
    (event: IpcMainInvokeEvent, payload: BlobPayload) => {
      if (!isFromRecorder(event)) {
        return { ok: false, error: 'untrusted-sender' }
      }
      if (!pendingStop) {
        // VAD/cap auto-stop fired before main asked to stop; ignore but log.
        log.warn('[recorder] audio-blob with no pending stop — dropping')
        return { ok: false, error: 'no-pending-stop' }
      }
      const stop = pendingStop
      try {
        const buf = Buffer.from(payload.buffer)
        const pcm =
          payload.pcm && payload.pcm.byteLength > 0
            ? new Float32Array(payload.pcm)
            : null
        clearTimeout(stop.timer)
        stop.resolve({
          audio: buf,
          pcm,
          speechMs: sanitizeStat(payload.speechMs),
          peakLevel: sanitizeStat(payload.peakLevel, 1),
        })
        pendingStop = null
        return { ok: true }
      } catch (err) {
        clearTimeout(stop.timer)
        stop.reject(err as Error)
        pendingStop = null
        return { ok: false, error: 'blob-decode-failed' }
      }
    },
  )

  // Reply leg of the on-demand PCM decode round-trip. Same trust model as
  // every other recorder channel: only the recorder window's sender id is
  // accepted, and the payload is validated before touching the pending map.
  ipcMain.on('recorder:decode-pcm-result', (event, payload: { id?: unknown; pcm?: unknown }) => {
    if (!isFromRecorder(event)) return
    if (!payload || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) return
    const pending = pendingDecodes.get(payload.id)
    if (!pending) return // timed out or duplicate reply — already settled
    pendingDecodes.delete(payload.id)
    clearTimeout(pending.timer)
    try {
      pending.resolve(
        payload.pcm instanceof ArrayBuffer && payload.pcm.byteLength > 0
          ? new Float32Array(payload.pcm)
          : null,
      )
    } catch (err) {
      log.warn('[recorder] decode-pcm result parse failed', err)
      pending.resolve(null)
    }
  })

  ipcMain.on('recorder:auto-stop', (event) => {
    if (!isFromRecorder(event)) return
    autoStopHandlers.forEach((h) => {
      try { h() } catch (err) { log.warn('autoStop handler threw', err) }
    })
  })

  // Live PCM frames for the True Streaming path. Hot channel (~20 Hz while
  // dictating) so validation is cheap and rejection is silent: a dropped
  // frame only degrades the live preview — the MediaRecorder blob still has
  // every sample. Same trust model as every recorder channel.
  ipcMain.on('recorder:pcm-frame', (event, payload: unknown) => {
    if (!isFromRecorder(event)) return
    if (!pcmFrameHandler) return // no active stream session — drop
    if (!(payload instanceof ArrayBuffer)) return
    if (payload.byteLength === 0 || payload.byteLength > MAX_PCM_FRAME_BYTES) return
    try {
      pcmFrameHandler(Buffer.from(payload))
    } catch (err) {
      log.warn('[recorder] pcm frame handler threw', err)
    }
  })

  // Renderer could not build the 16 kHz worklet graph — the streaming overlay
  // is off for this session, recording continues on the batch path.
  ipcMain.on('recorder:pcm-unavailable', (event, reason: unknown) => {
    if (!isFromRecorder(event)) return
    const sanitized = typeof reason === 'string' ? reason.slice(0, 200) : 'unknown'
    log.warn(`[recorder] pcm streaming unavailable: ${sanitized}`)
    try {
      pcmUnavailableHandler?.(sanitized)
    } catch (err) {
      log.warn('[recorder] pcm-unavailable handler threw', err)
    }
  })

  // Live audio levels: forwarded straight to the overlay window. Validate the
  // payload aggressively — this fires ~30Hz so we don't want to spend cycles,
  // but malformed values (NaN, out-of-range) would corrupt the bar heights.
  ipcMain.on('recorder:levels', (event, payload: unknown) => {
    if (!isFromRecorder(event)) return
    if (!Array.isArray(payload)) return
    if (payload.length === 0 || payload.length > 64) return
    const target = levelTargetWindow
    if (!target || target.isDestroyed()) return
    const clean = new Array<number>(payload.length)
    for (let i = 0; i < payload.length; i++) {
      const v = payload[i]
      clean[i] = typeof v === 'number' && Number.isFinite(v)
        ? (v < 0 ? 0 : v > 1 ? 1 : v)
        : 0
    }
    target.webContents.send('audio-levels', clean)
  })
}

function isFromRecorder(event: { sender: { id: number } }): boolean {
  return (
    recorderWindow !== null &&
    !recorderWindow.isDestroyed() &&
    event.sender.id === recorderWindow.webContents.id
  )
}

/** Renderer-supplied stats are untrusted numbers: NaN/Infinity/negatives are
 *  normalized to null ("no reading"), and an optional max clamps peakLevel
 *  into the 0..1 range the level pipeline is defined over. */
function sanitizeStat(value: unknown, max?: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return max !== undefined && value > max ? max : value
}

function rejectPending(reason: string): void {
  if (pendingStart) {
    clearTimeout(pendingStart.timer)
    pendingStart.reject(new Error(reason))
    pendingStart = null
  }
  if (pendingStop) {
    clearTimeout(pendingStop.timer)
    pendingStop.reject(new Error(reason))
    pendingStop = null
  }
}

function handleCrash(reason: string): void {
  log.error(`[recorder] crash: ${reason}`)
  rejectPending(reason)
  // In-flight decode requests can never be answered by a dead window —
  // resolve them null now instead of letting each wait out its 15 s timer.
  flushPendingDecodes()
  crashHandlers.forEach((cb) => {
    try {
      cb(reason)
    } catch (err) {
      log.warn('crash handler threw', err)
    }
  })
}
