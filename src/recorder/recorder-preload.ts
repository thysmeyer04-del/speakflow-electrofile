import { contextBridge, ipcRenderer } from 'electron'

type Unsub = () => void

contextBridge.exposeInMainWorld('recorderAPI', {
  onStart: (cb: (payload: { microphoneId: string; streaming?: boolean }) => void): Unsub => {
    const wrapped = (_e: unknown, p: { microphoneId: string; streaming?: boolean }) => cb(p)
    ipcRenderer.on('recorder:start', wrapped)
    return () => ipcRenderer.removeListener('recorder:start', wrapped)
  },
  onWarmup: (cb: (payload: { microphoneId: string }) => void): Unsub => {
    const wrapped = (_e: unknown, p: { microphoneId: string }) => cb(p)
    ipcRenderer.on('recorder:warmup', wrapped)
    return () => ipcRenderer.removeListener('recorder:warmup', wrapped)
  },
  onStop: (cb: () => void): Unsub => {
    const wrapped = () => cb()
    ipcRenderer.on('recorder:stop', wrapped)
    return () => ipcRenderer.removeListener('recorder:stop', wrapped)
  },
  reportStarted: () => ipcRenderer.send('recorder:started'),
  reportFailed: (message: string) => ipcRenderer.send('recorder:failed', message),
  reportAutoStop: () => ipcRenderer.send('recorder:auto-stop'),
  sendBlob: (payload: { buffer: ArrayBuffer; mimeType: string; pcm?: ArrayBuffer | null }) =>
    ipcRenderer.invoke('recorder:audio-blob', payload),
  // Streaming: a pause-delimited slice of the in-progress recording, shipped
  // early so main can transcribe it while the user keeps talking.
  sendPartialSegment: (payload: {
    index: number
    buffer: ArrayBuffer
    mimeType: string
    pcm: ArrayBuffer | null
  }) => ipcRenderer.send('recorder:partial-segment', payload),
  // Fire-and-forget level updates for the overlay waveform. Payload is a small
  // array of 0..1 floats (one per bar). Validation lives in main/recorder.ts.
  sendLevels: (levels: number[]) => ipcRenderer.send('recorder:levels', levels),
})
