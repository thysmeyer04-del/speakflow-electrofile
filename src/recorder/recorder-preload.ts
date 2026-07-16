import { contextBridge, ipcRenderer } from 'electron'

type Unsub = () => void

contextBridge.exposeInMainWorld('recorderAPI', {
  onStart: (cb: (payload: { microphoneId: string; needPcm?: boolean }) => void): Unsub => {
    const wrapped = (_e: unknown, p: { microphoneId: string; needPcm?: boolean }) => cb(p)
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
  // On-demand PCM decode: main can't run Web Audio, so when the
  // cloud-unreachable → local-Whisper fallback needs 16 kHz samples it
  // round-trips the compressed blob through this window. Request/response is
  // correlated by `id` (main keeps a pending map keyed on it).
  onDecodePcm: (cb: (payload: { id: number; buffer: ArrayBuffer }) => void): Unsub => {
    const wrapped = (_e: unknown, p: { id: number; buffer: ArrayBuffer }) => cb(p)
    ipcRenderer.on('recorder:decode-pcm', wrapped)
    return () => ipcRenderer.removeListener('recorder:decode-pcm', wrapped)
  },
  sendDecodedPcm: (payload: { id: number; pcm: ArrayBuffer | null }) =>
    ipcRenderer.send('recorder:decode-pcm-result', payload),
  reportStarted: () => ipcRenderer.send('recorder:started'),
  reportFailed: (message: string) => ipcRenderer.send('recorder:failed', message),
  reportAutoStop: () => ipcRenderer.send('recorder:auto-stop'),
  // speechMs/peakLevel: the level monitor's speech-energy stats, consumed by
  // main's hallucination guard (speech gate + dictionary-prompt suppression).
  sendBlob: (payload: {
    buffer: ArrayBuffer
    mimeType: string
    pcm?: ArrayBuffer | null
    speechMs?: number | null
    peakLevel?: number | null
  }) => ipcRenderer.invoke('recorder:audio-blob', payload),
  // Fire-and-forget level updates for the overlay waveform. Payload is a small
  // array of 0..1 floats (one per bar). Validation lives in main/recorder.ts.
  sendLevels: (levels: number[]) => ipcRenderer.send('recorder:levels', levels),
})
