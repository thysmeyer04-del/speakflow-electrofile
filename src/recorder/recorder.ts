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
// Tracks which deviceId warmStream was opened for so we can detect a mic
// change in settings and avoid recording from the wrong device.
let warmMicrophoneId: string | null = null
// GainNode pipeline that gives a fixed 1.4x boost on top of AGC so quiet
// mics still deliver enough energy for reliable Whisper transcription.
let gainAudioCtx: AudioContext | null = null
let gainDestStream: MediaStream | null = null
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
let bufferedBlob: { buffer: ArrayBuffer; mimeType: string; pcm: ArrayBuffer | null } | null = null

// ── Streaming segmentation ───────────────────────────────────────────────
// When enabled, the recording is cut at natural speech pauses: the current
// MediaRecorder is flushed, its audio is shipped to main as a "partial
// segment" (transcribed in the background while the user keeps talking), and
// a fresh MediaRecorder starts immediately on the same warm stream. The
// stop-to-paste latency then only covers the final tail segment.
let streamingEnabled = false
let segmentIndex = 0
let segmentStartAt = 0
// Loudest level seen in the CURRENT segment — a segment is only cut if it
// actually contains speech, so silent sessions never produce partials and
// the whole-session silence gate below stays authoritative.
let segmentPeakLevel = 0
let silentSinceTs: number | null = null
// Adaptive noise floor: real mics (AGC + room noise + the sqrt perceptual
// curve in downsampleToBars) idle well above the old fixed 0.06 threshold,
// which meant a pause was NEVER detected and streaming silently degraded to
// single-shot transcription. Track the quietest recent level instead and
// call "silence" anything near it.
let noiseFloorLevel = 1
let segLogFrameCounter = 0
let pendingSegmentCut: Promise<void> | null = null
// The stream/mime the active MediaRecorder was built with — needed to spin
// up the replacement recorder mid-session.
let activeRecorderStream: MediaStream | null = null
let activeMimeType: string | undefined
// A segment must have at least this much audio before a pause can cut it.
const SEGMENT_MIN_MS = 4_000
// How long the level must stay quiet before we treat it as a pause.
const SEGMENT_SILENCE_MS = 600
// Minimum silence threshold for segmentation; the effective threshold is
// adaptive: max(this, noiseFloor * 1.4 + 0.05).
const SEGMENT_SILENCE_LEVEL = 0.08
// Hard ceiling (10 min at one cut every ~4 s) — runaway-loop backstop.
const SEGMENT_MAX_COUNT = 150

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
// Silence gate: if the loudest moment of the entire recording never crossed
// this normalized level, the clip is silence/background hiss — drop it so it
// never reaches Whisper (which hallucinates words like "you" / "Thank you" on
// silent input). Deliberately low: any real speech pushes the bars well above
// this. Tunable via the [recorder] peak-level log line if it's ever too strict.
const SILENCE_PEAK_THRESHOLD = 0.05
// Peak normalized audio level seen during the current recording session.
let sessionPeakLevel = 0
// How many level frames the monitor actually processed this session. If the
// level monitor never ran (e.g. AudioContext unavailable), we have no energy
// reading and MUST fail open — otherwise the silence gate would drop every clip.
let levelFrameCount = 0

console.log('[recorder.ts] script loaded; recorderAPI?', typeof window.recorderAPI)
if (!window.recorderAPI) {
  console.error('[recorder.ts] FATAL: recorderAPI not exposed by preload — main will time out')
} else {
  window.recorderAPI.onWarmup(async (payload) => {
    await warmupMicStream(payload.microphoneId)
  })

  window.recorderAPI.onStart(async (payload) => {
    console.log('[recorder.ts] received start', payload)
    await start(payload.microphoneId, payload.streaming === true)
  })

  window.recorderAPI.onStop(async () => {
    console.log('[recorder.ts] received stop')
    await handleMainStop()
  })
}

async function warmupMicStream(microphoneId: string): Promise<void> {
  try {
    const requestedId = microphoneId || 'default'
    if (
      warmStream &&
      warmStream.getAudioTracks().every(t => t.readyState === 'live') &&
      warmMicrophoneId === requestedId
    ) return
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
    warmMicrophoneId = requestedId
    console.log('[recorder.ts] mic stream warmed up')
  } catch (err) {
    warmStream = null
    console.warn('[recorder.ts] warmup failed — first recording will call getUserMedia', err)
  }
}

async function start(microphoneId: string, streaming = false): Promise<void> {
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

  const requestedMicId = microphoneId || 'default'
  const hasWarmTracks =
    warmStream &&
    warmStream.getAudioTracks().every(t => t.readyState === 'live') &&
    warmMicrophoneId === requestedMicId
  if (hasWarmTracks) {
    mediaStream = warmStream!
    console.log('[recorder.ts] reusing warm mic stream — skipped getUserMedia')
  } else {
    warmStream = null
    warmMicrophoneId = null
    console.log('[recorder.ts] requesting getUserMedia', constraints)
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
      warmStream = mediaStream // cache for next recording
      warmMicrophoneId = requestedMicId
      console.log('[recorder.ts] getUserMedia resolved — got stream', mediaStream.getAudioTracks().length, 'tracks')
    } catch (err) {
      console.error('[recorder.ts] getUserMedia rejected:', (err as Error).message)
      localState = 'idle'
      window.recorderAPI.reportFailed(`mic-permission: ${(err as Error).message}`)
      return
    }
  }

  // Route mediaStream through a 1.4x GainNode so quiet mics still deliver
  // enough energy for reliable Whisper transcription. Falls back to the raw
  // stream if the Web Audio API is unavailable.
  let recorderStream: MediaStream = mediaStream
  try {
    const AudioCtor =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (AudioCtor) {
      gainAudioCtx = new AudioCtor()
      const src = gainAudioCtx.createMediaStreamSource(mediaStream)
      const gain = gainAudioCtx.createGain()
      gain.gain.value = 1.4
      const dest = gainAudioCtx.createMediaStreamDestination()
      src.connect(gain)
      gain.connect(dest)
      gainDestStream = dest.stream
      recorderStream = gainDestStream
    }
  } catch {
    // Non-fatal — record without boost rather than failing the session.
    gainAudioCtx = null
    gainDestStream = null
  }

  const mimeType = pickMimeType()
  try {
    mediaRecorder = new MediaRecorder(
      recorderStream,
      mimeType ? { mimeType } : undefined,
    )
  } catch (err) {
    await cleanup()
    localState = 'idle'
    window.recorderAPI.reportFailed(`recorder-init: ${(err as Error).message}`)
    return
  }

  attachRecorderHandlers(mediaRecorder)

  // Streaming segmentation session state.
  streamingEnabled = streaming
  activeRecorderStream = recorderStream
  activeMimeType = mimeType
  segmentIndex = 0
  segmentStartAt = Date.now()
  segmentPeakLevel = 0
  silentSinceTs = null
  noiseFloorLevel = 1
  segLogFrameCounter = 0

  sessionPeakLevel = 0
  levelFrameCount = 0
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

// Shared by the session's first MediaRecorder and every streaming-segment
// replacement recorder.
function attachRecorderHandlers(rec: MediaRecorder): void {
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  rec.onerror = (e: Event) => {
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
}

// Called ~30Hz from the level monitor. Detects a sustained speech pause and
// cuts the current audio into a partial segment that main can transcribe
// while the user keeps talking.
function maybeCutSegment(frameLevel: number): void {
  if (!streamingEnabled) return
  if (localState !== 'recording') {
    silentSinceTs = null
    return
  }

  // Adapt the noise floor: drop instantly to quieter levels; drift up ONLY
  // from near-floor frames, so sustained speech can't drag the floor into
  // speech range (observed in the field: floor 0.72 → threshold 1.06 → every
  // frame counted as "silence" and segments got cut mid-speech on a timer).
  if (frameLevel < noiseFloorLevel) {
    noiseFloorLevel = frameLevel
  } else if (frameLevel < noiseFloorLevel * 1.8) {
    noiseFloorLevel = Math.min(1, noiseFloorLevel * 0.99 + frameLevel * 0.01)
  }
  // Hard cap keeps the threshold safely below speech levels (~0.9-1.0).
  const silenceThreshold = Math.min(
    0.55,
    Math.max(SEGMENT_SILENCE_LEVEL, noiseFloorLevel * 1.3 + 0.04),
  )

  // Visibility while tuning: one line every ~5s of recording.
  if (++segLogFrameCounter % 150 === 0) {
    console.log(
      `[seg] level=${frameLevel.toFixed(3)} floor=${noiseFloorLevel.toFixed(3)} thr=${silenceThreshold.toFixed(3)} segAge=${Date.now() - segmentStartAt}ms cuts=${segmentIndex}`,
    )
  }

  if (pendingSegmentCut || pendingFinalize || pendingFlush || errorRecovery) return
  if (segmentIndex >= SEGMENT_MAX_COUNT) return
  const now = Date.now()
  if (now - segmentStartAt < SEGMENT_MIN_MS) {
    silentSinceTs = null
    return
  }
  if (frameLevel >= silenceThreshold) {
    silentSinceTs = null
    return
  }
  // Never cut a segment that contains no speech — keep accumulating instead,
  // so fully-silent sessions still hit the whole-session silence gate.
  if (segmentPeakLevel < SILENCE_PEAK_THRESHOLD) return
  if (silentSinceTs === null) {
    silentSinceTs = now
    return
  }
  if (now - silentSinceTs < SEGMENT_SILENCE_MS) return
  silentSinceTs = null
  pendingSegmentCut = cutSegment()
    .catch((err) => console.warn('[recorder] segment cut failed', err))
    .finally(() => {
      pendingSegmentCut = null
    })
}

async function cutSegment(): Promise<void> {
  const rec = mediaRecorder
  const stream = activeRecorderStream
  if (!rec || rec.state === 'inactive' || !stream) return

  // Flush the current recorder so its chunks are complete.
  await new Promise<void>((resolve) => {
    rec.onstop = () => resolve()
    try {
      rec.stop()
    } catch {
      resolve()
    }
  })

  // A user stop / error may have raced us — leave everything for finalize.
  if (localState !== 'recording') return

  const segChunks = chunks
  chunks = []

  // Restart immediately — the gap lands inside the silence we just detected.
  try {
    mediaRecorder = new MediaRecorder(
      stream,
      activeMimeType ? { mimeType: activeMimeType } : undefined,
    )
    attachRecorderHandlers(mediaRecorder)
    mediaRecorder.start(50)
  } catch (err) {
    // Can't restart: put the audio back so finalize still delivers it, and
    // surface a recorder failure so main reconciles the session.
    chunks = segChunks
    window.recorderAPI.reportFailed(`segment-restart: ${(err as Error).message}`)
    return
  }

  const index = segmentIndex++
  segmentStartAt = Date.now()
  segmentPeakLevel = 0

  const mime = segChunks[0]?.type || activeMimeType || 'audio/webm'
  const blob = new Blob(segChunks, { type: mime })
  if (blob.size === 0) return
  const buffer = await blob.arrayBuffer()
  const pcm = await decodeToPcm16k(buffer)
  console.log(`[recorder] segment ${index} cut (${blob.size}B) — sent for background transcription`)
  window.recorderAPI.sendPartialSegment?.({ index, buffer, mimeType: mime, pcm })
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
  // A segment cut mid-flight owns the MediaRecorder handoff — wait for it so
  // we finalize the replacement recorder, not the one it already stopped.
  if (pendingSegmentCut) {
    await pendingSegmentCut.catch(() => undefined)
  }

  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer)
    maxDurationTimer = null
  }

  if (!mediaRecorder) {
    bufferedBlob = { buffer: new ArrayBuffer(0), mimeType: 'audio/webm', pcm: null }
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

  // Gates apply to the WHOLE session, so when streaming already shipped
  // partial segments the tail must always go through — a sub-800ms or silent
  // tail after minutes of speech is normal, not an accidental press.
  const hasPartialSegments = segmentIndex > 0
  const tooShort =
    !hasPartialSegments && Date.now() - recordingStartedAt < MIN_RECORDING_MS
  // Silence gate: drop a clip whose loudest moment never crossed the speech
  // floor. Sending silence to Whisper produces phantom words. Fail open if the
  // level monitor never produced a reading (levelFrameCount === 0).
  const silent =
    !hasPartialSegments &&
    levelFrameCount > 0 &&
    sessionPeakLevel < SILENCE_PEAK_THRESHOLD
  console.log(`[recorder] session peak-level ${sessionPeakLevel.toFixed(3)} over ${levelFrameCount} frames (silence<${SILENCE_PEAK_THRESHOLD}=${silent}), tooShort=${tooShort}, partials=${segmentIndex}`)
  if (tooShort || blob.size === 0 || silent) {
    bufferedBlob = { buffer: new ArrayBuffer(0), mimeType: 'audio/webm', pcm: null }
    return
  }

  try {
    const buffer = await blob.arrayBuffer()
    bufferedBlob = {
      buffer,
      mimeType: blob.type || 'audio/webm',
      // Fail-open: local transcription needs PCM, cloud only needs the blob.
      pcm: await decodeToPcm16k(buffer),
    }
  } catch (err) {
    window.recorderAPI.reportFailed(`buffer-failed: ${(err as Error).message}`)
    bufferedBlob = { buffer: new ArrayBuffer(0), mimeType: 'audio/webm', pcm: null }
  }
}

// Decode the compressed recording to 16 kHz mono Float32 PCM — the input
// format on-device Whisper needs. Main can't do this (no Web Audio in Node),
// so the recorder ships PCM alongside the blob. Null on any failure: cloud
// transcription still works from the blob alone.
async function decodeToPcm16k(encoded: ArrayBuffer): Promise<ArrayBuffer | null> {
  let ctx: AudioContext | null = null
  try {
    const t0 = performance.now()
    // decodeAudioData resamples to the context's rate, so a 16 kHz context
    // yields Whisper-ready samples directly.
    ctx = new AudioContext({ sampleRate: 16_000 })
    const decoded = await ctx.decodeAudioData(encoded.slice(0))
    const pcm = decoded.getChannelData(0)
    // Copy: getChannelData views the AudioBuffer's memory; we transfer a
    // standalone ArrayBuffer over IPC.
    const out = new Float32Array(pcm.length)
    out.set(pcm)
    console.log(`[recorder] decoded ${decoded.duration.toFixed(1)}s to 16k PCM in ${Math.round(performance.now() - t0)}ms`)
    return out.buffer
  } catch (err) {
    console.warn('[recorder] PCM decode failed — cloud-only for this clip', err)
    return null
  } finally {
    if (ctx) ctx.close().catch(() => undefined)
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
        bufferedBlob = { buffer: new ArrayBuffer(0), mimeType: 'audio/webm', pcm: null }
      }
      const { buffer, mimeType, pcm } = bufferedBlob
      bufferedBlob = null
      localState = 'flushed'
      await sendBlobSafe(buffer, mimeType, pcm)
      localState = 'idle'
    } finally {
      pendingFlush = null
    }
  })()
  return pendingFlush
}

async function sendBlobSafe(
  buffer: ArrayBuffer,
  mimeType: string,
  pcm: ArrayBuffer | null = null,
): Promise<void> {
  try {
    await window.recorderAPI.sendBlob({ buffer, mimeType, pcm })
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
  // Streaming refs die with the session; segmentIndex intentionally survives
  // until the next start() — finalize's gates read it after cleanup().
  activeRecorderStream = null
  activeMimeType = undefined
  silentSinceTs = null
  if (mediaRecorder) {
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    } catch {
      // ignore
    }
    mediaRecorder = null
  }
  if (gainAudioCtx) {
    gainAudioCtx.close().catch(() => undefined)
    gainAudioCtx = null
  }
  gainDestStream = null
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
      // Track the loudest bar seen this session for the silence gate.
      levelFrameCount++
      let frameLevel = 0
      for (let i = 0; i < levels.length; i++) {
        if (levels[i] > sessionPeakLevel) sessionPeakLevel = levels[i]
        if (levels[i] > frameLevel) frameLevel = levels[i]
      }
      if (frameLevel > segmentPeakLevel) segmentPeakLevel = frameLevel
      maybeCutSegment(frameLevel)
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
