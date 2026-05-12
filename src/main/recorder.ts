import { BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import log from 'electron-log/main'

let recorderWindow: BrowserWindow | null = null
let pendingResolve: ((data: Buffer) => void) | null = null
let pendingReject: ((err: Error) => void) | null = null
let pendingTimer: NodeJS.Timeout | null = null

const MAX_RECORDING_MS = 60_000

export function initRecorder(): void {
  if (recorderWindow) return

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

  recorderWindow.loadFile(path.join(__dirname, '..', 'recorder', 'recorder.html'))
    .catch((err) => log.error('Failed to load recorder window', err))

  recorderWindow.on('closed', () => {
    recorderWindow = null
  })

  ipcMain.removeHandler('recorder:audio-blob')
  ipcMain.handle('recorder:audio-blob', (_event, payload: { buffer: ArrayBuffer; mimeType: string }) => {
    if (!pendingResolve) return { ok: false, error: 'no-pending-request' }
    clearTimer()
    try {
      const buf = Buffer.from(payload.buffer)
      pendingResolve(buf)
    } catch (err) {
      pendingReject?.(err as Error)
    } finally {
      pendingResolve = null
      pendingReject = null
    }
    return { ok: true }
  })

  ipcMain.on('recorder:error', (_event, message: string) => {
    log.error('Recorder error', message)
    clearTimer()
    pendingReject?.(new Error(message))
    pendingResolve = null
    pendingReject = null
  })
}

function clearTimer() {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
}

export function destroyRecorder(): void {
  clearTimer()
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.destroy()
  }
  recorderWindow = null
}

export async function startRecording(opts: { microphoneId?: string }): Promise<void> {
  if (!recorderWindow) initRecorder()
  await waitForRecorderReady()
  recorderWindow!.webContents.send('recorder:start', { microphoneId: opts.microphoneId || 'default' })
}

export function stopRecording(): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (!recorderWindow) {
      reject(new Error('Recorder window not initialised'))
      return
    }
    if (pendingResolve) {
      reject(new Error('Another recording is already being finalised'))
      return
    }
    pendingResolve = resolve
    pendingReject = reject
    pendingTimer = setTimeout(() => {
      pendingResolve = null
      pendingReject = null
      reject(new Error('Recorder did not return audio within timeout'))
    }, MAX_RECORDING_MS + 5_000)

    recorderWindow.webContents.send('recorder:stop')
  })
}

async function waitForRecorderReady(): Promise<void> {
  if (!recorderWindow) throw new Error('Recorder window missing')
  if (!recorderWindow.webContents.isLoading()) return
  await new Promise<void>((resolve) => {
    recorderWindow!.webContents.once('did-finish-load', () => resolve())
  })
}
