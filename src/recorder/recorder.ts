// Hidden renderer window that owns getUserMedia + MediaRecorder.
//
// Protocol with main:
//   main → 'recorder:start' { microphoneId }
//   renderer → 'recorder:started' (ACK once MediaRecorder.start() is OK)
//   renderer → 'recorder:failed' <reason> (any failure during start)
//
//   VAD or 60s cap (auto-stop): renderer stops mediaRecorder, buffers blob,
//     sends 'recorder:auto-stop'. It WAITS for main's 'recorder:stop' before
//     sending the blob, so main has time to set up its pendingStop and there
//     is no race where the blob arrives before main is ready.
//
//   User stop:
//   main → 'recorder:stop'
//   renderer → 'recorder:audio-blob' (or empty buffer if too short)

declare global {
  interface Window {
    recorderAPI: {
      onStart: (cb: (payload: { microphoneId: string }) => void) => () => void
      onStop: (cb: () => void) => () => void
      reportStarted: () => void
      reportFailed: (message: string) => void
      reportAutoStop: () => void
      sendBlob: (payload: { buffer: ArrayBuffer; mimeType: string }) => Promise<{ ok: boolean }>
    }
  }
}

type LocalState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'           // mediaRecorder.stop() is running
  | 'awaiting-flush'     // auto-stopped, blob buffered, waiting for main 'recorder:stop'
  | 'flushed'

let localState: LocalState = 'idle'
let mediaRecorder: MediaRecorder | null = null
let mediaStream: MediaStream | null = null
let chunks: Blob[] = []
let bufferedBlob: { buffer: ArrayBuffer; mimeType: string } | null = null
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
  await handleMainStop()
})

async function start(microphoneId: string): Promise<void> {
  if (localState !== 'idle') {
    window.recorderAPI.reportFailed(`overlapping-start (state=${localState})`)
    return
  }
  localState = 'starting'
  await cleanup()
  chunks = []
  bufferedBlob = null

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
    localState = 'idle'
    window.recorderAPI.reportFailed(`mic-permission: ${(err as Error).message}`)
    return
  }

  const mimeType = pickMimeType()
  try {
    mediaRecorder = new MediaRecorder(
      mediaStream,
      mimeType ? { mimeType } : undefined,
    )
  } catch (err) {
    await cleanup()
    localState = 'idle'
    window.recorderAPI.reportFailed(`recorder-init: ${(err as Error).message}`)
    return
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  mediaRecorder.onerror = (e: Event) => {
    const err = (e as ErrorEvent).error ?? (e as unknown as { error?: Error }).error
    void cleanup().finally(() => {
      localState = 'idle'
      bufferedBlob = null
      window.recorderAPI.reportFailed(
        `mediarecorder-error: ${err?.message ?? 'unknown'}`,
      )
    })
  }

  setupVAD()
  recordingStartedAt = Date.now()
  try {
    mediaRecorder.start(250)
  } catch (err) {
    await cleanup()
    localState = 'idle'
    window.recorderAPI.reportFailed(`recorder-start: ${(err as Error).message}`)
    return
  }

  localState = 'recording'

  maxDurationTimer = window.setTimeout(() => {
    void autoStop()
  }, MAX_DURATION_MS)

  window.recorderAPI.reportStarted()
}

// VAD / cap initiated: stop mediaRecorder, buffer the blob, then wait for
// main's stop. We DON'T auto-flush after a timeout — sending a blob without
// a pendingStop on main side just drops the audio. Instead, re-notify
// periodically so main has multiple chances to observe the auto-stop.
async function autoStop(): Promise<void> {
  if (localState !== 'recording') return
  localState = 'stopping'
  await finalizeMediaRecorder()
  localState = 'awaiting-flush'
  window.recorderAPI.reportAutoStop()
  // Re-notify every 2s for up to 10s if main hasn't asked for the blob yet.
  let attempts = 0
  const reNotify = window.setInterval(() => {
    if (localState !== 'awaiting-flush' || attempts >= 5) {
      clearInterval(reNotify)
      return
    }
    attempts++
    window.recorderAPI.reportAutoStop()
  }, 2000)
}

// Main asked to stop. Always reply with a blob (even empty) so main's
// pendingStop resolves — never silently return, that would hang main for
// 10 s until the stop timeout.
async function handleMainStop(): Promise<void> {
  if (localState === 'awaiting-flush') {
    await flushBuffered()
    return
  }
  if (localState === 'recording') {
    localState = 'stopping'
    await finalizeMediaRecorder()
    await flushBuffered()
    return
  }
  // idle, starting, stopping, or flushed: nothing to send. Reply empty.
  await sendBlobSafe(new ArrayBuffer(0), 'audio/webm')
}

async function finalizeMediaRecorder(): Promise<void> {
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
    bufferedBlob = { buffer: new ArrayBuffer(0), mimeType: 'audio/webm' }
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

  const tooShort = Date.now() - recordingStartedAt < MIN_RECORDING_MS
  if (tooShort || blob.size === 0) {
    bufferedBlob = { buffer: new ArrayBuffer(0), mimeType: 'audio/webm' }
    return
  }

  try {
    bufferedBlob = {
      buffer: await blob.arrayBuffer(),
      mimeType: blob.type || 'audio/webm',
    }
  } catch (err) {
    window.recorderAPI.reportFailed(`buffer-failed: ${(err as Error).message}`)
    bufferedBlob = { buffer: new ArrayBuffer(0), mimeType: 'audio/webm' }
  }
}

async function flushBuffered(): Promise<void> {
  if (!bufferedBlob) {
    bufferedBlob = { buffer: new ArrayBuffer(0), mimeType: 'audio/webm' }
  }
  const { buffer, mimeType } = bufferedBlob
  bufferedBlob = null
  localState = 'flushed'
  await sendBlobSafe(buffer, mimeType)
  localState = 'idle'
}

async function sendBlobSafe(buffer: ArrayBuffer, mimeType: string): Promise<void> {
  try {
    await window.recorderAPI.sendBlob({ buffer, mimeType })
  } catch (err) {
    window.recorderAPI.reportFailed(`send-failed: ${(err as Error).message}`)
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
        void autoStop()
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

export {}
