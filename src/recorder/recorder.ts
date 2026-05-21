// Hidden renderer window that owns getUserMedia + MediaRecorder.
//
// Protocol with main:
//   main → 'recorder:start' { microphoneId }
//   renderer → 'recorder:started' (ACK once MediaRecorder.start() is OK)
//   renderer → 'recorder:failed' <reason> (any failure during start)
//
//   10-min cap (auto-stop): renderer stops mediaRecorder, buffers blob,
//     sends 'recorder:auto-stop'. It WAITS for main's 'recorder:stop' before
//     sending the blob, so main has time to set up its pendingStop and there
//     is no race where the blob arrives before main is ready. There is NO
//     silence-driven VAD auto-stop — the user controls stop via F11.
//
//   User stop:
//   main → 'recorder:stop'
//   renderer → 'recorder:audio-blob' (or empty buffer if too short)

// Types for window.recorderAPI live in src/types/recorder-api.d.ts so this
// file stays a plain script (no module wrappers) — it's loaded via <script>
// in recorder.html.

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
// Kept alive across recordings so getUserMedia is only called once at startup.
// The mic indicator stays on while the app is running — acceptable for a
// dictation tool where instant start is the primary goal.
let warmStream: MediaStream | null = null
let chunks: Blob[] = []
let levelAudioCtx: AudioContext | null = null
let levelAnalyser: AnalyserNode | null = null
let levelSource: MediaStreamAudioSourceNode | null = null
let levelRafId: number | null = null

// Number of bars rendered in the overlay waveform. Keep in sync with the
// .bars span count in overlay.html.
const LEVEL_BAR_COUNT = 21
// fftSize=64 -> 32 frequency bins. We average chunks of these into LEVEL_BAR_COUNT.
const LEVEL_FFT_SIZE = 64
// Throttle level emission. RAF would push 60Hz; 30Hz is plenty for the eye and
// halves the IPC chatter.
const LEVEL_EMIT_MIN_MS = 33
let bufferedBlob: { buffer: ArrayBuffer; mimeType: string } | null = null
let maxDurationTimer: number | null = null
let recordingStartedAt = 0
// Set whenever finalizeMediaRecorder is in flight so a concurrent stop
// request (e.g. user F11 while VAD-driven autoStop is mid-await on
// mediaRecorder.onstop) can await the same finalize instead of racing past
// 'stopping' and replying with 0 bytes before the real audio is buffered.
let pendingFinalize: Promise<void> | null = null
// Same pattern for flushBuffered — guards against two concurrent callers
// (e.g. an autoStop-driven flush racing a user-stop-driven flush) both
// copying bufferedBlob and emitting two audio-blob IPC payloads.
let pendingFlush: Promise<void> | null = null
// Single-flight guard for mediaRecorder.onerror: error events can fire twice
// in quick succession (e.g. device unplug + stream-error), and each one
// spawns an async IIFE. Without this guard those IIFEs race through cleanup
// and can clobber the globals of a freshly-started new session.
let errorRecovery: Promise<void> | null = null
// Monotonic counter for autoStop sessions. The re-notify tick chain captures
// its session-id in closure and bails on every tick if a newer autoStop has
// superseded it — without this, an unfinished tick chain from a previous
// awaiting-flush could fire reportAutoStop() for a later session.
let autoStopSession = 0

// 10-min absolute cap so a forgotten-to-stop recording can't grow without
// bound. At 16 kHz mono Opus that's ~1.2 MB — comfortably under the 25 MB
// Groq Whisper upload ceiling.
const MAX_DURATION_MS = 600_000
const MIN_RECORDING_MS = 800

console.log('[recorder.ts] script loaded; recorderAPI?', typeof window.recorderAPI)
if (!window.recorderAPI) {
  console.error('[recorder.ts] FATAL: recorderAPI not exposed by preload — main will time out')
} else {
  window.recorderAPI.onWarmup(async (payload) => {
    await warmupMicStream(payload.microphoneId)
  })

  window.recorderAPI.onStart(async (payload) => {
    console.log('[recorder.ts] received start', payload)
    await start(payload.microphoneId)
  })

  window.recorderAPI.onStop(async () => {
    console.log('[recorder.ts] received stop')
    await handleMainStop()
  })
}

async function warmupMicStream(microphoneId: string): Promise<void> {
  try {
    if (warmStream && warmStream.getAudioTracks().every(t => t.readyState === 'live')) return
    warmStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: microphoneId && microphoneId !== 'default' ? { exact: microphoneId } : undefined,
        channelCount: 1,
        sampleRate: 16_000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    console.log('[recorder.ts] mic stream warmed up')
  } catch (err) {
    warmStream = null
    console.warn('[recorder.ts] warmup failed — first recording will call getUserMedia', err)
  }
}

async function start(microphoneId: string): Promise<void> {
  if (localState === 'starting' || localState === 'recording') {
    // Only legitimately-active states reject. Everything else is treated as
    // a wedge — see below.
    window.recorderAPI.reportFailed(`overlapping-start (state=${localState})`)
    return
  }
  if (localState !== 'idle') {
    // Safety net: a prior session left us in 'stopping' / 'awaiting-flush' /
    // 'flushed' (e.g. main timed out, or the autoStop-vs-handleMainStop race
    // dropped the buffered blob). Reset rather than locking the user out
    // until app restart.
    console.warn(`[recorder.ts] start in wedge state=${localState} — resetting`)
    // Wait for any in-flight finalize/flush/error-recovery to settle first —
    // otherwise their continuations would write bufferedBlob / chunks AFTER
    // we reset them and poison the new session.
    if (pendingFinalize) {
      await pendingFinalize.catch(() => undefined)
    }
    if (pendingFlush) {
      await pendingFlush.catch(() => undefined)
    }
    if (errorRecovery) {
      await errorRecovery.catch(() => undefined)
    }
    await cleanup()
    pendingFinalize = null
    pendingFlush = null
    errorRecovery = null
    bufferedBlob = null
    chunks = []
    localState = 'idle'
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

  const hasWarmTracks = warmStream && warmStream.getAudioTracks().every(t => t.readyState === 'live')
  if (hasWarmTracks) {
    mediaStream = warmStream!
    console.log('[recorder.ts] reusing warm mic stream — skipped getUserMedia')
  } else {
    warmStream = null
    console.log('[recorder.ts] requesting getUserMedia', constraints)
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
      warmStream = mediaStream // cache for next recording
      console.log('[recorder.ts] getUserMedia resolved — got stream', mediaStream.getAudioTracks().length, 'tracks')
    } catch (err) {
      console.error('[recorder.ts] getUserMedia rejected:', (err as Error).message)
      localState = 'idle'
      window.recorderAPI.reportFailed(`mic-permission: ${(err as Error).message}`)
      return
    }
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
    // Second concurrent error from the same MediaRecorder instance: the first
    // IIFE is already tearing down — skip rather than racing a parallel reset.
    if (errorRecovery) return
    const err = (e as ErrorEvent).error ?? (e as unknown as { error?: Error }).error
    errorRecovery = (async () => {
      try {
        // Wait for any in-flight finalize/flush so their continuations can't
        // write bufferedBlob after we declare the recorder idle and clear it.
        if (pendingFinalize) {
          await pendingFinalize.catch(() => undefined)
        }
        if (pendingFlush) {
          await pendingFlush.catch(() => undefined)
        }
        await cleanup()
        pendingFinalize = null
        pendingFlush = null
        localState = 'idle'
        bufferedBlob = null
        window.recorderAPI.reportFailed(
          `mediarecorder-error: ${err?.message ?? 'unknown'}`,
        )
      } finally {
        errorRecovery = null
      }
    })()
  }

  recordingStartedAt = Date.now()
  try {
    // 50ms timeslice: reduces maximum last-chunk latency on stop from 100ms to
    // 50ms, so the final words are less likely to be clipped on a quick press.
    mediaRecorder.start(50)
  } catch (err) {
    await cleanup()
    localState = 'idle'
    window.recorderAPI.reportFailed(`recorder-start: ${(err as Error).message}`)
    return
  }

  startLevelMonitor()

  localState = 'recording'

  maxDurationTimer = window.setTimeout(() => {
    void autoStop()
  }, MAX_DURATION_MS)

  window.recorderAPI.reportStarted()
}

// Idempotent: if a finalize is already in flight, a second caller awaits the
// same promise instead of starting a duplicate finalize or racing past it.
function finalizeOnce(): Promise<void> {
  if (!pendingFinalize) {
    pendingFinalize = finalizeMediaRecorder().finally(() => {
      pendingFinalize = null
    })
  }
  return pendingFinalize
}

// VAD / cap initiated: stop mediaRecorder, buffer the blob, then wait for
// main's stop. We DON'T auto-flush after a timeout — sending a blob without
// a pendingStop on main side just drops the audio. Instead, re-notify
// periodically so main has multiple chances to observe the auto-stop.
async function autoStop(): Promise<void> {
  if (localState !== 'recording') return
  localState = 'stopping'
  await finalizeOnce()
  // A concurrent handleMainStop may have taken over and already flushed.
  if (localState !== 'stopping') return
  localState = 'awaiting-flush'
  // Capture session-id so the tick chain self-cancels if a later autoStop
  // (i.e. a later recording session) starts its own tick chain — without
  // this, stale chains from prior sessions could keep firing reportAutoStop
  // for a fresh awaiting-flush window.
  const mySession = ++autoStopSession
  window.recorderAPI.reportAutoStop()
  // Re-notify until state leaves 'awaiting-flush' (main collected the blob,
  // or wedge recovery in start() reset us). No finite cap — any ceiling
  // could permanently strand bufferedBlob if main is in 'stopping'/'processing'
  // for the whole notify window. Backoff after 30 s so the long tail doesn't
  // spam main forever, and self-terminates by simply not rescheduling.
  let elapsedMs = 0
  let intervalMs = 2_000
  const tick = (): void => {
    if (mySession !== autoStopSession) return
    if (localState !== 'awaiting-flush') return
    window.recorderAPI.reportAutoStop()
    elapsedMs += intervalMs
    if (elapsedMs >= 30_000 && intervalMs < 10_000) {
      intervalMs = 10_000
    }
    window.setTimeout(tick, intervalMs)
  }
  window.setTimeout(tick, intervalMs)
}

// Main asked to stop. Always reply with a blob (even empty) so main's
// pendingStop resolves — never silently return, that would hang main for
// 10 s until the stop timeout.
async function handleMainStop(): Promise<void> {
  // If autoStop is mid-finalize, wait for it. Otherwise we'd see state
  // 'stopping', fall through to the empty-blob fallback, and reply with
  // 0 bytes — leaving the recorder wedged in 'awaiting-flush' afterward.
  if (pendingFinalize) {
    await pendingFinalize.catch(() => undefined)
  }
  if (localState === 'awaiting-flush') {
    await flushBuffered()
    return
  }
  if (localState === 'recording') {
    localState = 'stopping'
    await finalizeOnce()
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
  // Idempotent like finalizeOnce: a concurrent second caller awaits the same
  // promise instead of double-emitting an audio-blob (main only honours the
  // first via single-shot pendingStop; the second would be silently dropped).
  if (pendingFlush) return pendingFlush
  pendingFlush = (async () => {
    try {
      if (!bufferedBlob) {
        bufferedBlob = { buffer: new ArrayBuffer(0), mimeType: 'audio/webm' }
      }
      const { buffer, mimeType } = bufferedBlob
      bufferedBlob = null
      localState = 'flushed'
      await sendBlobSafe(buffer, mimeType)
      localState = 'idle'
    } finally {
      pendingFlush = null
    }
  })()
  return pendingFlush
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

async function cleanup(): Promise<void> {
  // Clear the 10-min cap timer here too, not just in finalizeMediaRecorder.
  // If cleanup runs via the mediaRecorder.onerror recovery path, the timer
  // would otherwise outlive its session and fire autoStop() during a later
  // recording (autoStop only checks localState, not session identity).
  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer)
    maxDurationTimer = null
  }
  stopLevelMonitor()
  if (mediaRecorder) {
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    } catch {
      // ignore
    }
    mediaRecorder = null
  }
  if (mediaStream) {
    // Don't stop warm stream tracks — they persist for the next recording to
    // skip getUserMedia. Only stop tracks on a non-warm (one-off) stream.
    if (mediaStream !== warmStream) {
      mediaStream.getTracks().forEach((t) => t.stop())
    }
    mediaStream = null
  }
}

// ── Audio level monitor (drives the overlay waveform bars) ────────────────
function startLevelMonitor(): void {
  if (!mediaStream || levelRafId !== null) return
  try {
    const AudioCtor =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtor) return
    levelAudioCtx = new AudioCtor()
    levelSource = levelAudioCtx.createMediaStreamSource(mediaStream)
    levelAnalyser = levelAudioCtx.createAnalyser()
    levelAnalyser.fftSize = LEVEL_FFT_SIZE
    levelAnalyser.smoothingTimeConstant = 0.55
    levelSource.connect(levelAnalyser)
  } catch (err) {
    console.warn('[recorder.ts] level monitor init failed', err)
    stopLevelMonitor()
    return
  }

  const binCount = levelAnalyser.frequencyBinCount  // = fftSize / 2
  const buf = new Uint8Array(binCount)
  let lastEmit = 0

  const tick = (): void => {
    if (!levelAnalyser) return
    const now = performance.now()
    if (now - lastEmit >= LEVEL_EMIT_MIN_MS) {
      lastEmit = now
      levelAnalyser.getByteFrequencyData(buf)
      const levels = downsampleToBars(buf, LEVEL_BAR_COUNT)
      try {
        window.recorderAPI.sendLevels?.(levels)
      } catch {
        // Level emission is opportunistic; never break recording over it.
      }
    }
    levelRafId = window.requestAnimationFrame(tick)
  }
  levelRafId = window.requestAnimationFrame(tick)
}

function stopLevelMonitor(): void {
  if (levelRafId !== null) {
    window.cancelAnimationFrame(levelRafId)
    levelRafId = null
  }
  if (levelSource) {
    try { levelSource.disconnect() } catch { /* ignore */ }
    levelSource = null
  }
  if (levelAnalyser) {
    try { levelAnalyser.disconnect() } catch { /* ignore */ }
    levelAnalyser = null
  }
  if (levelAudioCtx) {
    levelAudioCtx.close().catch(() => undefined)
    levelAudioCtx = null
  }
  // Tell the overlay to reset its bars to baseline.
  try {
    window.recorderAPI.sendLevels?.(new Array(LEVEL_BAR_COUNT).fill(0))
  } catch {
    // ignore
  }
}

// Average groups of FFT bins into `barCount` buckets, normalize 0..1, and
// apply a mild perceptual curve so quiet speech still moves the bars.
function downsampleToBars(buf: Uint8Array, barCount: number): number[] {
  const out = new Array<number>(barCount)
  const binsPerBar = Math.max(1, Math.floor(buf.length / barCount))
  for (let i = 0; i < barCount; i++) {
    const start = i * binsPerBar
    const end = i === barCount - 1 ? buf.length : start + binsPerBar
    let sum = 0
    for (let j = start; j < end; j++) sum += buf[j]
    const avg = sum / Math.max(1, end - start) / 255
    // sqrt curve: amplify low-amplitude motion without clipping highs.
    out[i] = Math.min(1, Math.sqrt(avg))
  }
  return out
}
