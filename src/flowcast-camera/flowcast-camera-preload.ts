import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('flowcastCamera', {
  sendFrame: (frame: Uint8Array) => ipcRenderer.send('flowcast-camera:frame', frame),
  ready: () => ipcRenderer.send('flowcast-camera:ready'),
  error: (message: string) => ipcRenderer.send('flowcast-camera:error', message.slice(0, 300)),
  onStart: (callback: () => void) => {
    const listener = (_event: IpcRendererEvent) => callback()
    ipcRenderer.on('flowcast-camera:start', listener)
    return () => ipcRenderer.removeListener('flowcast-camera:start', listener)
  },
  onStop: (callback: () => void) => {
    const listener = (_event: IpcRendererEvent) => callback()
    ipcRenderer.on('flowcast-camera:stop', listener)
    return () => ipcRenderer.removeListener('flowcast-camera:stop', listener)
  },
})
