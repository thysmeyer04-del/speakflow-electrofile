// Hidden renderer window that owns getUserMedia + MediaRecorder.
//
// Protocol with main:
//   main → 'recorder:start' { microphoneId, needPcm }
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
//   renderer → 'recorder:audio-blob' (or empty buffer if too short). The
//     payload also carries speechMs/peakLevel — the level monitor's speech
//     energy stats — which main's hallucination guard uses to drop silent
//     clips before they ever reach Whisper.
//
//   On-demand PCM decode (main can't run Web Audio):
//   main → 'recorder:decode-pcm' { id, buffer }
//   renderer → 'recorder:decode-pcm-result' { id, pcm|null }
//     Used by the cloud-unreachable → local-Whisper fallback: in cloud mode
//     we no longer decode PCM eagerly at stop time (it cost 200-600 ms on the
//     hot path for a payload the cloud path never reads), so main round-trips
//     the compressed blob back here only when local inference actually needs
//     samples.
//
//   Live PCM tap (True Streaming, 2026-07): when the start payload carries
//   streamPcm:true, a SECOND AudioContext pinned to 16 kHz runs an
//   AudioWorklet ('pcm16-frames', staged as pcm-worklet.js beside this file)
//   that ships 50 ms int16 frames to main via 'recorder:pcm-frame'. Main
//   forwards them to a Deepgram WebSocket it owns. If the tap can't be built
//   (device refuses 16 kHz, worklet load fails) the renderer reports
//   'recorder:pcm-unavailable' and the session continues batch-only — the
//   MediaRecorder below ALWAYS runs regardless of streamPcm, so streaming
//   failures can never lose audio.
//
// Segment-on-pause streaming was REMOVED (Fast Batch, 2026-07): partial
// segments never fired in any of 37 logged production sessions (the pause
// detector's preconditions were effectively unreachable with real mics), and
// Groq bills a 10 s minimum per uploaded segment, so each cut would have
// multiplied cost for zero latency win. The adaptive-noise-floor idea from
// that code lives on below in the speech-seconds tracker. True Streaming
// (above) is a different beast: one persistent socket, no per-segment billing.

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

interface BufferedAudio {
  buffer: ArrayBuffer
  mimeType: string
  pcm: ArrayBuffer | null
  // Speech-energy stats for main's hallucination guard. null = the level
  // monitor never produced a reading this session (AudioContext unavailable),
  // in which case main MUST fail open — see sessionSpeechStats().
  speechMs: number | null
  peakLevel: number | null
}
let bufferedBlob: BufferedAudio | null = null

// ── Speech-seconds tracking (feeds main's hallucination guard) ────────────
// The level monitor (~30 Hz) integrates how much of the session actually
// contained speech-level audio. Main uses the total to (a) drop clips with
// <400 ms of speech before they reach Whisper — silent-room clips make
// Whisper invent whole sentences — and (b) suppress the dictionary-bias
// prompt on very short clips, where the prompt AMPLIFIES hallucinations
// (Whisper happily "hears" the prompt words inside noise).
//
// Adaptive noise floor: real mics (AGC + room noise + the sqrt perceptual
// curve in downsampleToBars) idle well above any usable fixed threshold —
// observed idle floors up to ~0.7 in the field. Track the quietest recent
// level instead and count as "speech" only frames comfortably above it:
// level > max(floor * SPEECH_FLOOR_MULT, SPEECH_LEVEL_MIN).
let noiseFloorLevel = 1
let sessionSpeechMs = 0
// performance.now() of the previous processed level frame. Speech time is
// integrated from real inter-frame deltas — not a nominal frame length — so
// a throttled RAF in the hidden window can't inflate the count.
let lastLevelFrameTs = 0
const SPEECH_LEVEL_MIN = 0.08
const SPEECH_FLOOR_MULT = 1.3
// One stretched frame gap (GC pause, window deprioritized) must not credit
// seconds of "speech" in a single tick — cap the per-frame delta.
const SPEECH_FRAME_MAX_CREDIT_MS = 250
// Only decode the blob to 16 kHz PCM at stop time when main said it will
// actually consume it (local transcription mode). Cloud mode skips the
// decode entirely — it was pure waste on the stop→paste hot path.
let needPcmEnabled = false

// ── Live PCM tap (True Streaming) ───────────────────────────────────────────
// Separate AudioContext from the gain/level ones: it must be pinned to
// 16 kHz (Deepgram linear16 contract) while the others run at device rate.
let pcmAudioCtx: AudioContext | null = null
let pcmSource: MediaStreamAudioSourceNode | null = null
let pcmGain: GainNode | null = null
let pcmMute: GainNode | null = null
let pcmWorklet: AudioWorkletNode | null = null
// Monotonic guard: addModule() is async, and a stop can land mid-setup. Each
// setup captures its id and bails after every await if teardown (which bumps
// the counter) happened underneath it.
let pcmSession = 0
// Teardown grace: the 'flush' port message and the tail frame it produces
// are asynchronous hops (main thread → audio thread → main thread). Closing
// the context in the same tick would eat the tail — give it a beat.
const PCM_FLUSH_GRACE_MS = 100

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
    await start(payload.microphoneId, payload.needPcm === true, payload.streamPcm === true)
  })

  window.recorderAPI.onStop(async () => {
    console.log('[recorder.ts] received stop')
    await handleMainStop()
  })

  // On-demand PCM decode for main's cloud-unreachable → local-Whisper
  // fallback (cloud sessions no longer decode eagerly at stop time). Always
  // reply — even with null — so main's pending promise settles immediately
  // instead of waiting out its timeout.
  window.recorderAPI.onDecodePcm?.(async (payload) => {
    let pcm: ArrayBuffer | null = null
    try {
      if (payload && payload.buffer instanceof ArrayBuffer && payload.buffer.byteLength > 0) {
        pcm = await decodeToPcm16k(payload.buffer)
      }
    } catch {
      pcm = null // decodeToPcm16k already fails soft; this is belt+braces
    }
    window.recorderAPI.sendDecodedPcm?.({ id: payload.id, pcm })
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

async function start(microphoneId: string, needPcm = false, streamPcm = false): Promise<void> {
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

  // Per-session speech-energy state.
  needPcmEnabled = needPcm
  noiseFloorLevel = 1
  sessionSpeechMs = 0
  lastLevelFrameTs = 0

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

  // Live PCM tap AFTER the start ACK, fire-and-forget: worklet setup takes
  // tens of ms and must never delay main's 'recording' transition. Frames
  // that miss the socket's opening moments are main's problem to buffer —
  // and any setup failure only means this session streams nothing.
  if (streamPcm && mediaStream) {
    void startPcmStream(mediaStream)
  }
}

// ── Live PCM tap: 16 kHz worklet graph for True Streaming ──────────────────
// mediaStream → MediaStreamSource → GainNode(1.4x, same boost the recording
// gets so Deepgram hears what Whisper would) → AudioWorkletNode
// ('pcm16-frames') → muted gain → destination. The muted sink matters:
// Chromium only pulls (and therefore only calls process() on) graph branches
// that terminate in a rendered output; gain 0 keeps the tap silent.
async function startPcmStream(stream: MediaStream): Promise<void> {
  const mySession = ++pcmSession
  let ctx: AudioContext | null = null
  try {
    // decode-rate pinning: a 16 kHz context makes Chromium do the resampling
    // from the device rate for us, so the worklet's samples are wire-ready.
    ctx = new AudioContext({ sampleRate: 16_000 })
    if (Math.round(ctx.sampleRate) !== 16_000) {
      // Device/UA refused the rate (rare — Chromium normally honors it).
      // Skip streaming for this session; NEVER fail the recording over it.
      console.warn(`[recorder] pcm tap unavailable: context rate ${ctx.sampleRate}`)
      window.recorderAPI.reportPcmUnavailable?.(`sample-rate:${ctx.sampleRate}`)
      ctx.close().catch(() => undefined)
      return
    }
    // Resolved relative to recorder.html's URL (dist/recorder/), where
    // copy-assets.mjs stages the module beside this script.
    await ctx.audioWorklet.addModule('pcm-worklet.js')
    if (mySession !== pcmSession || localState !== 'recording') {
      // Stop/teardown raced the async module load — abandon quietly.
      ctx.close().catch(() => undefined)
      return
    }
    const source = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    gain.gain.value = 1.4
    const worklet = new AudioWorkletNode(ctx, 'pcm16-frames', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const mute = ctx.createGain()
    mute.gain.value = 0
    worklet.port.onmessage = (event: MessageEvent) => {
      const frame = event.data as Int16Array
      if (frame instanceof Int16Array && frame.length > 0) {
        try {
          // The worklet transferred the buffer, so it's exactly this frame's
          // bytes — no offset/length bookkeeping needed.
          window.recorderAPI.sendPcmFrame?.(frame.buffer as ArrayBuffer)
        } catch {
          // Frame loss only trims the live preview — never break recording.
        }
      }
    }
    source.connect(gain)
    gain.connect(worklet)
    worklet.connect(mute)
    mute.connect(ctx.destination)
    pcmAudioCtx = ctx
    pcmSource = source
    pcmGain = gain
    pcmWorklet = worklet
    pcmMute = mute
    console.log('[recorder] pcm tap live (16 kHz worklet)')
  } catch (err) {
    console.warn('[recorder] pcm tap init failed — session is batch-only', err)
    try {
      window.recorderAPI.reportPcmUnavailable?.(`init-failed: ${(err as Error).message}`)
    } catch {
      // ignore — main will fall back on its own finalize timeout
    }
    if (ctx) ctx.close().catch(() => undefined)
  }
}

function stopPcmStream(): void {
  pcmSession++ // cancels any in-flight startPcmStream setup
  const ctx = pcmAudioCtx
  const worklet = pcmWorklet
  const source = pcmSource
  const gain = pcmGain
  const mute = pcmMute
  pcmAudioCtx = null
  pcmWorklet = null
  pcmSource = null
  pcmGain = null
  pcmMute = null
  if (!ctx && !worklet) return
  // Order matters: cut the source first (no new samples), THEN ask the
  // worklet to flush its partial tail frame, THEN close after a grace period
  // long enough for the two async port hops to complete. onmessage stays
  // attached so the tail still reaches main (where a finalized ASR session
  // simply drops it — the MediaRecorder blob has the same audio).
  try { source?.disconnect() } catch { /* ignore */ }
  try { gain?.disconnect() } catch { /* ignore */ }
  try { worklet?.port.postMessage('flush') } catch { /* ignore */ }
  window.setTimeout(() => {
    try { worklet?.disconnect() } catch { /* ignore */ }
    try { mute?.disconnect() } catch { /* ignore */ }
    if (ctx) ctx.close().catch(() => undefined)
  }, PCM_FLUSH_GRACE_MS)
}

// One MediaRecorder per session (streaming's mid-session replacement
// recorders are gone) — kept as a function so the error-recovery wiring
// stays in one place.
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

// Called ~30 Hz from the level monitor with the loudest bar of the frame.
// Maintains the adaptive noise floor and integrates speech-seconds for the
// hallucination guard (see the state block up top for the full rationale).
function trackSpeechEnergy(frameLevel: number, frameTs: number): void {
  // Adapt the noise floor: drop instantly to quieter levels; drift up ONLY
  // from near-floor frames, so sustained speech can't drag the floor into
  // speech range (observed in the field with the old symmetric drift: floor
  // 0.72 → threshold above every frame → all speech misclassified).
  if (frameLevel < noiseFloorLevel) {
    noiseFloorLevel = frameLevel
  } else if (frameLevel < noiseFloorLevel * 1.8) {
    noiseFloorLevel = Math.min(1, noiseFloorLevel * 0.99 + frameLevel * 0.01)
  }

  const speechThreshold = Math.max(noiseFloorLevel * SPEECH_FLOOR_MULT, SPEECH_LEVEL_MIN)
  // Integrate real elapsed time between frames (capped) rather than assuming
  // the nominal 33 ms cadence — RAF in a hidden window is not metronomic.
  const deltaMs =
    lastLevelFrameTs > 0
      ? Math.min(frameTs - lastLevelFrameTs, SPEECH_FRAME_MAX_CREDIT_MS)
      : LEVEL_EMIT_MIN_MS
  lastLevelFrameTs = frameTs
  if (frameLevel > speechThreshold) sessionSpeechMs += deltaMs
}

/** Speech stats shipped with the audio blob. null when the level monitor
 *  never ran (no AudioContext) — main fails OPEN on null, otherwise the
 *  speech gate would eat every clip on such machines. */
function sessionSpeechStats(): { speechMs: number | null; peakLevel: number | null } {
  if (levelFrameCount === 0) return { speechMs: null, peakLevel: null }
  return { speechMs: Math.round(sessionSpeechMs), peakLevel: sessionPeakLevel }
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
  await sendBlobSafe({
    buffer: new ArrayBuffer(0),
    mimeType: 'audio/webm',
    pcm: null,
    speechMs: null,
    peakLevel: null,
  })
}

async function finalizeMediaRecorder(): Promise<void> {
  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer)
    maxDurationTimer = null
  }

  if (!mediaRecorder) {
    bufferedBlob = emptyBufferedAudio()
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
  // Silence gate: drop a clip whose loudest moment never crossed the speech
  // floor. Sending silence to Whisper produces phantom words. Fail open if the
  // level monitor never produced a reading (levelFrameCount === 0).
  const silent = levelFrameCount > 0 && sessionPeakLevel < SILENCE_PEAK_THRESHOLD
  console.log(`[recorder] session peak-level ${sessionPeakLevel.toFixed(3)} speech=${Math.round(sessionSpeechMs)}ms over ${levelFrameCount} frames (silence<${SILENCE_PEAK_THRESHOLD}=${silent}), tooShort=${tooShort}`)
  if (tooShort || blob.size === 0 || silent) {
    bufferedBlob = emptyBufferedAudio()
    return
  }

  try {
    const buffer = await blob.arrayBuffer()
    bufferedBlob = {
      buffer,
      mimeType: blob.type || 'audio/webm',
      // PCM is ONLY consumed by on-device Whisper. Cloud sessions skip the
      // decode (it cost 200-600 ms on the stop hot path for nothing); the
      // rare cloud-unreachable → local fallback re-requests it on demand via
      // 'recorder:decode-pcm'. Still fail-open (null) if the decode dies.
      pcm: needPcmEnabled ? await decodeToPcm16k(buffer) : null,
      ...sessionSpeechStats(),
    }
  } catch (err) {
    window.recorderAPI.reportFailed(`buffer-failed: ${(err as Error).message}`)
    bufferedBlob = emptyBufferedAudio()
  }
}

/** Empty payload that still carries the session's speech stats — main drops
 *  empty buffers before the stats matter, but keeping them accurate costs
 *  nothing and helps log forensics. */
function emptyBufferedAudio(): BufferedAudio {
  return {
    buffer: new ArrayBuffer(0),
    mimeType: 'audio/webm',
    pcm: null,
    ...sessionSpeechStats(),
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
        bufferedBlob = emptyBufferedAudio()
      }
      const payload = bufferedBlob
      bufferedBlob = null
      localState = 'flushed'
      await sendBlobSafe(payload)
      localState = 'idle'
    } finally {
      pendingFlush = null
    }
  })()
  return pendingFlush
}

async function sendBlobSafe(payload: BufferedAudio): Promise<void> {
  try {
    await window.recorderAPI.sendBlob(payload)
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
  // Live PCM tap teardown (flush + deferred close) — must run on EVERY
  // cleanup path (user stop, autoStop, error recovery, wedge reset) or a
  // leaked 16 kHz context would keep the audio pipeline warm forever.
  stopPcmStream()
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
      trackSpeechEnergy(frameLevel, now)
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
