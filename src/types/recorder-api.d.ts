interface Window {
  recorderAPI: {
    onStart: (
      cb: (payload: { microphoneId: string; needPcm?: boolean; streamPcm?: boolean }) => void,
    ) => () => void
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
    // True Streaming: live 50 ms int16 PCM frames + the "can't stream this
    // session" declaration. Optional (?) like every post-v1 API so the
    // renderer degrades gracefully against an older preload.
    sendPcmFrame?: (buf: ArrayBuffer) => void
    reportPcmUnavailable?: (reason: string) => void
  }
}
