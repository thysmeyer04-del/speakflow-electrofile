// Lifecycle owner for the hidden recorder BrowserWindow.

import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron'
import path from 'path'
import log from 'electron-log/main'

const READY_TIMEOUT_MS = 8_000
const START_TIMEOUT_MS = 5_000
const STOP_TIMEOUT_MS = 10_000

interface StartPayload { microphoneId: string; streaming?: boolean }
interface BlobPayload { buffer: ArrayBuffer; mimeType: string; pcm?: ArrayBuffer | null }
interface PartialSegmentPayload {
  index: number
  buffer: ArrayBuffer
  mimeType: string
  pcm?: ArrayBuffer | null
}

// A pause-delimited slice of an in-progress recording (streaming mode).
export interface PartialSegment {
  index: number
  audio: Buffer
  pcm: Float32Array | null
}

export interface RecorderResult {
  audio: Buffer
  // 16 kHz mono Float32 PCM decoded by the renderer — input for on-device
  // Whisper. Null when decode failed or the clip was dropped (silence/short).
  pcm: Float32Array | null
}

let recorderWindow: BrowserWindow | null = null
let readyPromise: Promise<void> | null = null
let readyResolved = false
let expectingClose = false
let crashHandlers: Array<(reason: string) => void> = []
let autoStopHandlers: Array<() => void> = []
let partialSegmentHandlers: Array<(seg: PartialSegment) => void> = []
// Where to forward live audio levels. Set once at startup by main.ts.
let levelTargetWindow: BrowserWindow | null = null

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

export function onPartialSegment(cb: (seg: PartialSegment) => void): () => void {
  partialSegmentHandlers.push(cb)
  return () => {
    partialSegmentHandlers = partialSegmentHandlers.filter((h) => h !== cb)
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
        stop.resolve({ audio: buf, pcm })
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

  ipcMain.on('recorder:partial-segment', (event, payload: PartialSegmentPayload) => {
    if (!isFromRecorder(event)) return
    if (!payload || typeof payload.index !== 'number' || !Number.isInteger(payload.index)) return
    if (payload.index < 0 || payload.index > 10_000) return
    if (!(payload.buffer instanceof ArrayBuffer) || payload.buffer.byteLength === 0) return
    let seg: PartialSegment
    try {
      seg = {
        index: payload.index,
        audio: Buffer.from(payload.buffer),
        pcm:
          payload.pcm instanceof ArrayBuffer && payload.pcm.byteLength > 0
            ? new Float32Array(payload.pcm)
            : null,
      }
    } catch (err) {
      log.warn('[recorder] partial-segment decode failed', err)
      return
    }
    partialSegmentHandlers.forEach((h) => {
      try { h(seg) } catch (err) { log.warn('partialSegment handler threw', err) }
    })
  })

  ipcMain.on('recorder:auto-stop', (event) => {
    if (!isFromRecorder(event)) return
    autoStopHandlers.forEach((h) => {
      try { h() } catch (err) { log.warn('autoStop handler threw', err) }
    })
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
  crashHandlers.forEach((cb) => {
    try {
      cb(reason)
    } catch (err) {
      log.warn('crash handler threw', err)
    }
  })
}
