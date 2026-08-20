import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type FlowcastStatePayload = { state: string; elapsedMs?: number }

contextBridge.exposeInMainWorld('flowcastControl', {
  getState: () => ipcRenderer.invoke('flowcast-control:get-state'),
  pauseOrResume: () => ipcRenderer.invoke('flowcast-control:pause-or-resume'),
  stop: () => ipcRenderer.invoke('flowcast-control:stop'),
  discard: () => ipcRenderer.invoke('flowcast-control:discard'),
  onState: (callback: (payload: FlowcastStatePayload) => void) => {
    const listener = (_event: IpcRendererEvent, payload: FlowcastStatePayload) => callback(payload)
    ipcRenderer.on('flowcast-control:state', listener)
    return () => ipcRenderer.removeListener('flowcast-control:state', listener)
  },
})
