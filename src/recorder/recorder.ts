// Hidden renderer window that owns getUserMedia + MediaRecorder.
// Talks to main only via the recorder-preload contextBridge (window.recorderAPI).

declare global {
  interface Window {
    recorderAPI: {
      onStart: (cb: (payload: { microphoneId: string }) => void) => () => void
      onStop: (cb: () => void) => () => void
      sendBlob: (payload: { buffer: ArrayBuffer; mimeType: string }) => Promise<{ ok: boolean }>
      reportError: (message: string) => void
    }
  }
}

let mediaRecorder: MediaRecorder | null = null
let mediaStream: MediaStream | null = null
let chunks: Blob[] = []
let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let vadTimer: number | null = null
let maxDurationTimer: number | null = null
let silenceStartedAt: number | null = null
let recordingStartedAt = 0

const MAX_DURATION_MS = 60_000
const SILENCE_RMS_THRESHOLD = 0.012
const SILENCE_DURATION_MS = 3_000
const MIN_RECORDING_MS = 800

window.recorderAPI.onStart(async (payload) => {
  await start(payload.microphoneId)
})

window.recorderAPI.onStop(async () => {
  await stop()
})

async function start(microphoneId: string): Promise<void> {
  await cleanup()
  chunks = []

  const constraints: MediaStreamConstraints = {
    audio: {
      deviceId:
        microphoneId && microphoneId !== 'default'
          ? { exact: microphoneId }
          : undefined,
      channelCount: 1,
      sampleRate: 16_000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
  } catch (err) {
    window.recorderAPI.reportError(`mic-permission: ${(err as Error).message}`)
    return
  }

  const mimeType = pickMimeType()
  try {
    mediaRecorder = new MediaRecorder(
      mediaStream,
      mimeType ? { mimeType } : undefined,
    )
  } catch (err) {
    window.recorderAPI.reportError(`recorder-init: ${(err as Error).message}`)
    await cleanup()
    return
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  mediaRecorder.onerror = (e: Event) => {
    const err = (e as ErrorEvent).error ?? (e as unknown as { error?: Error }).error
    window.recorderAPI.reportError(
      `mediarecorder-error: ${err?.message ?? 'unknown'}`,
    )
  }

  setupVAD()
  recordingStartedAt = Date.now()
  mediaRecorder.start(250)

  maxDurationTimer = window.setTimeout(() => {
    void stop()
  }, MAX_DURATION_MS)
}

async function stop(): Promise<void> {
  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer)
    maxDurationTimer = null
  }
  if (vadTimer) {
    clearInterval(vadTimer)
    vadTimer = null
  }
  silenceStartedAt = null

  if (!mediaRecorder) {
    await cleanup()
    await sendEmpty()
    return
  }

  await new Promise<void>((resolve) => {
    if (mediaRecorder!.state === 'inactive') return resolve()
    mediaRecorder!.onstop = () => resolve()
    try {
      mediaRecorder!.stop()
    } catch {
      resolve()
    }
  })

  const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' })
  await cleanup()

  if (
    Date.now() - recordingStartedAt < MIN_RECORDING_MS ||
    blob.size === 0
  ) {
    await sendEmpty()
    return
  }

  try {
    const buffer = await blob.arrayBuffer()
    await window.recorderAPI.sendBlob({ buffer, mimeType: blob.type })
  } catch (err) {
    window.recorderAPI.reportError(`send-failed: ${(err as Error).message}`)
  }
}

async function sendEmpty(): Promise<void> {
  try {
    await window.recorderAPI.sendBlob({
      buffer: new ArrayBuffer(0),
      mimeType: 'audio/webm',
    })
  } catch {
    // ignore
  }
}

function pickMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ]
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return undefined
}

function setupVAD(): void {
  if (!mediaStream) return
  audioContext = new AudioContext()
  const source = audioContext.createMediaStreamSource(mediaStream)
  analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  const data = new Float32Array(analyser.fftSize)

  vadTimer = window.setInterval(() => {
    if (!analyser) return
    analyser.getFloatTimeDomainData(data)
    let sumSquares = 0
    for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i]
    const rms = Math.sqrt(sumSquares / data.length)

    const now = Date.now()
    const elapsed = now - recordingStartedAt

    if (rms < SILENCE_RMS_THRESHOLD) {
      if (silenceStartedAt === null) silenceStartedAt = now
      else if (
        now - silenceStartedAt > SILENCE_DURATION_MS &&
        elapsed > MIN_RECORDING_MS
      ) {
        void stop()
      }
    } else {
      silenceStartedAt = null
    }
  }, 100)
}

async function cleanup(): Promise<void> {
  if (vadTimer) {
    clearInterval(vadTimer)
    vadTimer = null
  }
  if (mediaRecorder) {
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    } catch {
      // ignore
    }
    mediaRecorder = null
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop())
    mediaStream = null
  }
  if (audioContext) {
    try {
      await audioContext.close()
    } catch {
      // ignore
    }
    audioContext = null
    analyser = null
  }
}

export {} // ensure module scope
