import { contextBridge, ipcRenderer } from 'electron'

type Unsub = () => void

// Live-PCM frame ceiling — mirrors MAX_PCM_FRAME_BYTES in main/recorder.ts
// (defence in depth; main re-validates). A real frame is 1,600 bytes.
const MAX_PCM_FRAME_BYTES = 8_192

interface StartPayload {
  microphoneId: string
  needPcm?: boolean
  streamPcm?: boolean
}

contextBridge.exposeInMainWorld('recorderAPI', {
  onStart: (cb: (payload: StartPayload) => void): Unsub => {
    const wrapped = (_e: unknown, p: StartPayload) => cb(p)
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
  // True Streaming: one 50 ms int16 PCM frame from the AudioWorklet tap.
  // Fire-and-forget — a dropped frame only trims the live preview; the
  // MediaRecorder blob still carries every sample for the batch fallback.
  sendPcmFrame: (buf: ArrayBuffer) => {
    if (!(buf instanceof ArrayBuffer)) return
    if (buf.byteLength === 0 || buf.byteLength > MAX_PCM_FRAME_BYTES) return
    ipcRenderer.send('recorder:pcm-frame', buf)
  },
  // Renderer-side declaration that the 16 kHz worklet graph could not be
  // built this session (device refused the rate, module load failed, …).
  // Main tears down the ASR socket and lets the batch path carry the clip.
  reportPcmUnavailable: (reason: string) =>
    ipcRenderer.send('recorder:pcm-unavailable', String(reason).slice(0, 200)),
})
