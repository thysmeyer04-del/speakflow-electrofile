// Lifecycle owner for the hidden recorder BrowserWindow.
//
// Exposes a tiny, ACK-driven API to recording-controller.ts:
//   - startRecorderSession({ microphoneId }) -> Promise<void> when renderer
//     confirms it is recording (rejects on permission / init / timeout).
//   - stopRecorderSession() -> Promise<Buffer> when renderer ships its audio
//     blob (rejects on timeout or crash).
//   - onRecorderCrash(cb)
//   - isRecorderHealthy()
//
// The renderer is the single owner of MediaRecorder + VAD. VAD-initiated
// auto-stops still flow through stopRecorderSession's pending promise so the
// state machine reconciles correctly.

import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron'
import path from 'path'
import log from 'electron-log/main'

const READY_TIMEOUT_MS = 8_000
const START_TIMEOUT_MS = 5_000
const STOP_TIMEOUT_MS = 10_000

interface StartPayload { microphoneId: string }
interface BlobPayload { buffer: ArrayBuffer; mimeType: string }

let recorderWindow: BrowserWindow | null = null
let readyPromise: Promise<void> | null = null
let crashHandlers: Array<(reason: string) => void> = []

interface PendingStart {
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}
interface PendingStop {
  resolve: (buf: Buffer) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

let pendingStart: PendingStart | null = null
let pendingStop: PendingStop | null = null

// ── Public API ─────────────────────────────────────────────────────────────
export function initRecorder(): void {
  if (recorderWindow && !recorderWindow.isDestroyed()) return

  recorderWindow = new BrowserWindow({
    width: 1,
    height: 1,
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

  win.webContents.on('render-process-gone', (_e, details) => {
    handleCrash(`render-process-gone: ${details.reason}`)
  })
  win.webContents.on('unresponsive', () => {
    log.warn('[recorder] window unresponsive')
  })
  win.on('closed', () => {
    if (recorderWindow === win) recorderWindow = null
    handleCrash('window-closed')
  })

  readyPromise = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ready-timeout')), READY_TIMEOUT_MS)
    win.webContents.once('did-finish-load', () => {
      clearTimeout(t)
      resolve()
    })
    win.webContents.once('did-fail-load', (_e, _code, desc) => {
      clearTimeout(t)
      reject(new Error(`recorder-load-failed: ${desc}`))
    })
  })

  win.loadFile(path.join(__dirname, '..', 'recorder', 'recorder.html')).catch((err) => {
    log.error('[recorder] loadFile threw', err)
  })

  registerHandlers()
}

export function destroyRecorder(): void {
  rejectPending('shutdown')
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.destroy()
  }
  recorderWindow = null
  readyPromise = null
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

export async function startRecorderSession(opts: StartPayload): Promise<void> {
  if (!recorderWindow) initRecorder()
  if (!recorderWindow) throw new Error('recorder-init')

  // Wait for the renderer to be ready (with a hard timeout)
  if (readyPromise) {
    await readyPromise
  }

  if (pendingStart) throw new Error('start-already-pending')

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStart = null
      reject(new Error('ready-timeout'))
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

export async function stopRecorderSession(): Promise<Buffer> {
  if (!recorderWindow) throw new Error('recorder-missing')
  if (pendingStop) throw new Error('stop-already-pending')

  return new Promise<Buffer>((resolve, reject) => {
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

    // A failure can apply to start (preferred) or stop, depending on state.
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
        clearTimeout(stop.timer)
        stop.resolve(buf)
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

  // Renderer can request an auto-stop (VAD or 60s cap). Treat it as if the
  // user pressed the hotkey — but only if we are currently recording.
  ipcMain.on('recorder:auto-stop', (event) => {
    if (!isFromRecorder(event)) return
    // recording-controller will see the audio blob via 'recorder:audio-blob'
    // — but we still need to ensure main treats this as a stop. Forward to
    // the controller via an event.
    autoStopHandlers.forEach((h) => h())
  })
}

let autoStopHandlers: Array<() => void> = []
export function onAutoStop(cb: () => void): () => void {
  autoStopHandlers.push(cb)
  return () => {
    autoStopHandlers = autoStopHandlers.filter((h) => h !== cb)
  }
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
