interface Window {
  recorderAPI: {
    onStart: (cb: (payload: { microphoneId: string }) => void) => () => void
    onStop: (cb: () => void) => () => void
    onWarmup: (cb: (payload: { microphoneId: string }) => void) => () => void
    reportStarted: () => void
    reportFailed: (message: string) => void
    reportAutoStop: () => void
    sendBlob: (payload: { buffer: ArrayBuffer; mimeType: string }) => Promise<{ ok: boolean }>
    sendLevels?: (levels: number[]) => void
  }
}
