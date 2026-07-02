interface Window {
  recorderAPI: {
    onStart: (cb: (payload: { microphoneId: string; streaming?: boolean }) => void) => () => void
    onStop: (cb: () => void) => () => void
    onWarmup: (cb: (payload: { microphoneId: string }) => void) => () => void
    reportStarted: () => void
    reportFailed: (message: string) => void
    reportAutoStop: () => void
    sendBlob: (payload: { buffer: ArrayBuffer; mimeType: string; pcm?: ArrayBuffer | null }) => Promise<{ ok: boolean }>
    sendPartialSegment?: (payload: {
      index: number
      buffer: ArrayBuffer
      mimeType: string
      pcm: ArrayBuffer | null
    }) => void
    sendLevels?: (levels: number[]) => void
  }
}
