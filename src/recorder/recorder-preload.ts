import { contextBridge, ipcRenderer } from 'electron'

type Unsub = () => void

contextBridge.exposeInMainWorld('recorderAPI', {
  onStart: (cb: (payload: { microphoneId: string }) => void): Unsub => {
    const wrapped = (_e: unknown, p: { microphoneId: string }) => cb(p)
    ipcRenderer.on('recorder:start', wrapped)
    return () => ipcRenderer.removeListener('recorder:start', wrapped)
  },
  onStop: (cb: () => void): Unsub => {
    const wrapped = () => cb()
    ipcRenderer.on('recorder:stop', wrapped)
    return () => ipcRenderer.removeListener('recorder:stop', wrapped)
  },
  reportStarted: () => ipcRenderer.send('recorder:started'),
  reportFailed: (message: string) => ipcRenderer.send('recorder:failed', message),
  reportAutoStop: () => ipcRenderer.send('recorder:auto-stop'),
  sendBlob: (payload: { buffer: ArrayBuffer; mimeType: string }) =>
    ipcRenderer.invoke('recorder:audio-blob', payload),
})
