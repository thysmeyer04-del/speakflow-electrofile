import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('flowcastInk', {
  stroke: (payload: unknown) => ipcRenderer.send('flowcast-ink:stroke', payload),
  exit: () => ipcRenderer.send('flowcast-ink:exit'),
  onConfigure: (callback: (payload: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('flowcast-ink:configure', listener)
    return () => ipcRenderer.removeListener('flowcast-ink:configure', listener)
  },
  onClear: (callback: () => void) => {
    const listener = (_event: IpcRendererEvent) => callback()
    ipcRenderer.on('flowcast-ink:clear', listener)
    return () => ipcRenderer.removeListener('flowcast-ink:clear', listener)
  },
  onReset: (callback: () => void) => {
    const listener = (_event: IpcRendererEvent) => callback()
    ipcRenderer.on('flowcast-ink:reset', listener)
    return () => ipcRenderer.removeListener('flowcast-ink:reset', listener)
  },
})
