interface Window {
  recorderAPI: {
    onStart: (cb: (payload: { microphoneId: string; needPcm?: boolean }) => void) => () => void
    onStop: (cb: () => void) => () => void
    onWarmup: (cb: (payload: { microphoneId: string }) => void) => () => void
    // On-demand PCM decode round-trip for the cloud-unreachable → local
    // Whisper fallback (see recorder-preload.ts).
    onDecodePcm?: (cb: (payload: { id: number; buffer: ArrayBuffer }) => void) => () => void
    sendDecodedPcm?: (payload: { id: number; pcm: ArrayBuffer | null }) => void
    reportStarted: () => void
    reportFailed: (message: string) => void
    reportAutoStop: () => void
    sendBlob: (payload: {
      buffer: ArrayBuffer
      mimeType: string
      pcm?: ArrayBuffer | null
      speechMs?: number | null
      peakLevel?: number | null
    }) => Promise<{ ok: boolean }>
    sendLevels?: (levels: number[]) => void
  }
}
