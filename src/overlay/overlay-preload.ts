// Minimal preload for the overlay window. The overlay is purely a status
// indicator — it ONLY needs receive-side IPC for recording state. It MUST NOT
// expose settings, auth, or recording-control APIs.

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

type Unsub = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsub {
  const wrapped = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('electronAPI', {
  onRecordingStarted: (cb: () => void) => on<void>('recording-started', cb),
  onRecordingStopped: (cb: () => void) => on<void>('recording-stopped', cb),
  onProcessingStarted: (cb: () => void) => on<void>('processing-started', cb),
  onProcessingComplete: (cb: () => void) => on<void>('processing-complete', cb),
  onTranscriptionError: (cb: (msg: string) => void) =>
    on<string>('transcription-error', cb),
})
