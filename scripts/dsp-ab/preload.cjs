const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('harness', {
  saveTake: (take, arm, buffer) => ipcRenderer.invoke('save-take', { take, arm, buffer }),
  takesDir: () => ipcRenderer.invoke('takes-dir'),
})
