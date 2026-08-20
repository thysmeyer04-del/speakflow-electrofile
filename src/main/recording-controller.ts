// Single source of truth for the recording state machine.
//
// Serializes ALL start/stop operations through one async queue so that two
// rapid hotkey presses, a tray click, and a dashboard IPC cannot interleave.
//
// The hidden recorder window is the actual MediaRecorder host; this module
// orchestrates its lifecycle and waits for explicit renderer ACKs before
// transitioning states. Crash / timeout / mic-denied always reconcile back
// to idle and reject pending callers.

import { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import {
  startRecorderSession,
  stopRecorderSession,
  onRecorderCrash,
  onAutoStop,
  setPcmFrameHandler,
  setPcmUnavailableHandler,
} from './recorder'
import { transcribeAudio, getProxyBaseUrl } from './transcribe'
import { dictateViaProxy } from './dictate'
import { startAsrStream, AsrSession, AsrFinalizeResult } from './asr-stream'
import { asrErrorCode, reportStreamingUsage } from './asr-token'
import { isSilenceArtifact, ARTIFACT_MAX_SPEECH_MS } from './whisper-artifacts'
import { syncToKnowledgeBase } from './supabase'
import { getAuthToken, getAuthContext, ensureAuthToken, type AuthContext } from './ipc'
import { releaseMedia, tryAcquireMedia } from './media-owner'
import { getDeletionGeneration } from './event-outbox'
import { injectText, captureFocusTarget, WindowSnapshot } from './inject'
import { getSettings } from './settings'
import { playSound } from './sound'
import { abortInFlightTransform } from './transform-controller'
import {
  formatTranscript,
  shouldFormat,
  decideFormattedText,
  stripFillerWords,
  abortInFlightFormat,
  detectContextCategory,
} from './format-transcript'
import { getCommand, toneInstruction } from './commands-store'
import { transformText } from './transform-llm'
import {
  getDictionaryWords,
  expandSnippets,
  applyPronunciationAliases,
  getPronunciationSpellings,
} from './user-context'
import { isOriginTrusted } from './security'
import { waitForStopTail } from './recording-tail'

export type RecordingState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'processing'

let state: RecordingState = 'idle'
let listeners: Array<(s: RecordingState) => void> = []
let opChain: Promise<void> = Promise.resolve()
// The window the user was in WHEN they pressed the hotkey. We inject
// transcribed text back into this exact target — never whatever happens to
// be focused after the transcription round-trip.
let focusTarget: WindowSnapshot | null = null
// Monotonic session id — increments on every start AND on every crash so a
// stale async path can detect "this isn't my session" and bail out.
let sessionId = 0
// Set when the recording was started by a command hotkey (Ctrl+Shift+N with
// nothing highlighted): the transcript is run through that command's LLM
// prompt instead of being pasted verbatim.
let pendingCommandId: string | null = null
// Wall-clock moment the recorder ACKed 'recording-started' — used to report
// the actual audio duration (not processing time) in the completion payload.
let recordingStartedAt = 0
// Identity and deletion generation are captured at hotkey press. Every
// downstream write remains bound to this owner even if auth rotates, the user
// signs out, or a history purge races the in-flight recording.
let recordingAuthContext: AuthContext | null = null
let recordingGenerationPromise: Promise<number> = Promise.resolve(0)

export function getPendingCommandId(): string | null {
  return pendingCommandId
}

// NOTE on streaming history: segment-on-pause transcription (partial
// segments transcribed while the user was still talking) was deleted in the
// Fast Batch work — partials fired in 0 of 37 logged sessions, and Groq
// bills a 10 s minimum per uploaded segment. True Streaming (2026-07) now
// runs a Deepgram Nova-3 WebSocket (asr-stream.ts) fed with live PCM from
// the recorder window — but INVISIBLY: Thys rejected live words in the
// overlay (2026-07-16), so the pill shows only Listening/Transcribing and
// the finished text pastes. The 'partial-transcript' channel + overlay
// setPartial() renderer are kept dormant for a possible future opt-in.
//
// ── True Streaming state machine (per recording session) ───────────────────
//   doStart (eligible)  → recorder gets streamPcm:true AND the ASR socket is
//                         opened in parallel (never awaited on the hot path).
//                         PCM frames arriving before 'open' are backlogged
//                         and burst-fed once the socket resolves, so the
//                         stream transcript still covers the first words.
//   doStop              → session.finalize() runs IN PARALLEL with the
//                         recorder blob collection. Non-empty flush result →
//                         path='stream': skip /dictate entirely, feed the
//                         transcript into the SAME collapse → filler-strip →
//                         empty-guard → shouldFormat/formatTranscript →
//                         sanityCheck → snippets → inject post-pipeline.
//   any failure         → (mint/connect/pcm-unavailable/finalize-timeout/
//                         empty flush/socket death) log 'asr fallback
//                         reason=…' and let the batch pipeline process the
//                         MediaRecorder blob, which recorded the ENTIRE clip
//                         in parallel — streaming can never lose audio.
//   invalidation        → recorder crash / sign-out / shutdown bump sessionId
//                         and abort the socket via teardownAsrStream().

// ── Hallucination guard thresholds (work item E) ───────────────────────────
// A clip with less than this much measured speech-level audio is dropped
// client-side before any network call: Whisper reliably invents sentences
// (and occasionally profanity — reported in the field) on silent-room clips,
// and Groq bills a 10 s minimum for the privilege. The renderer's whole-clip
// PEAK gate stays as belt+braces — the peak gate catches "never louder than
// hiss", this speech-seconds gate catches "one door slam in a silent room".
const MIN_SPEECH_MS = 400

// ── Stream truncation guard (v0.7.1) ───────────────────────────────────────
// Deepgram stamps each committed segment with its span in the audio timeline,
// so "how much of what we sent became words" is measurable, not guesswork.
// Anything beyond this much un-transcribed tail means the flush settled early
// and the last words are lost — discard the stream and let the complete
// MediaRecorder audio go through the batch engine instead.
//
// 700 ms: trailing silence legitimately goes uncommitted (Deepgram ends the
// segment at the last word, not at the last frame), and the hotkey release
// itself always lands a beat after the final syllable. Below this we would
// throw away good streams and pay batch latency for nothing.
const STREAM_TAIL_TOLERANCE_MS = 700

function isStreamTruncated(result: AsrFinalizeResult): boolean {
  // coveredMs 0 = the API didn't report spans (older shape) — can't judge,
  // so trust the transcript rather than forcing everyone onto the slow path.
  if (result.coveredMs <= 0 || result.audioSentMs <= 0) return false
  return result.audioSentMs - result.coveredMs > STREAM_TAIL_TOLERANCE_MS
}

// ── True Streaming session state ────────────────────────────────────────────
// Live Deepgram session for the CURRENT recording, or null. Set only after
// the socket opens; doStop consumes it; every invalidation path clears it.
let asrSession: AsrSession | null = null
// True while the socket is still connecting — frames arriving in that window
// go to the backlog below instead of the floor, so the stream transcript
// isn't missing the user's first words (connect + token mint can take
// 300-1000 ms and people start talking immediately).
let asrPendingSetup = false
let asrBacklog: Buffer[] = []
// 400 frames × 50 ms = 20 s of backlog. If the socket hasn't opened by then
// the connection is hopeless — drop streaming for the session rather than
// hoarding audio in RAM (the batch blob has it all anyway).
const ASR_BACKLOG_MAX_FRAMES = 400

/** Abort/clear all streaming state. Safe to call at any time from any path —
 *  abort() on an already-finalized session is a no-op, and clearing the PCM
 *  handlers just means future frames drop harmlessly on the floor. */
function teardownAsrStream(reason: string): void {
  if (asrSession || asrPendingSetup) {
    log.info(`[asr] stream teardown (${reason})`)
  }
  if (asrSession) {
    try {
      asrSession.abort()
    } catch (err) {
      log.warn('[asr] abort threw', err)
    }
  }
  asrSession = null
  asrPendingSetup = false
  asrBacklog = []
  setPcmFrameHandler(null)
  setPcmUnavailableHandler(null)
}

/** Kick off the ASR socket + PCM plumbing for one session. Deliberately NOT
 *  awaited by doStart: streaming must never delay 'recording-started', and
 *  every outcome (open, mint failure, connect failure) is handled through
 *  session-guarded continuations below. */
function beginAsrStream(mySession: number, t0: number): void {
  asrBacklog = []
  asrPendingSetup = true

  setPcmFrameHandler((frame) => {
    if (mySession !== sessionId) return // stale session's frames — drop
    if (asrSession) {
      asrSession.sendFrame(frame)
      return
    }
    if (!asrPendingSetup) return // stream already declared dead — drop
    if (asrBacklog.length >= ASR_BACKLOG_MAX_FRAMES) {
      log.info('[timing] asr fallback reason=connect-backlog-overflow')
      teardownAsrStream('backlog-overflow')
      return
    }
    asrBacklog.push(frame)
  })

  setPcmUnavailableHandler((reason) => {
    if (mySession !== sessionId) return
    // The recorder window can't produce live PCM this session — a socket
    // with no audio is pointless, kill it (or the pending setup).
    log.info(`[timing] asr fallback reason=pcm-unavailable detail=${reason}`)
    teardownAsrStream('pcm-unavailable')
  })

  void startAsrStream({
    language: 'en',
    // Product decision (Thys, 2026-07-16): NO live words in the overlay —
    // the pill shows only "Listening" / "Transcribing…" like Wispr Flow, and
    // the text simply pastes. Streaming still runs underneath for the speed;
    // interims are consumed only by asr-stream's own timing logs. The
    // 'partial-transcript' channel + overlay renderer are kept dormant in
    // case live words ever return as an opt-in setting.
    onInterim: () => {},
    // Keyterm bias (v0.7.0): trained pronunciations first (user explicitly
    // recorded these), then dictionary head up to the cap of 20.
    keyterms: [...getPronunciationSpellings(), ...getDictionaryWords().slice(0, 20)],
  })
    .then((session) => {
      if (mySession !== sessionId || !asrPendingSetup) {
        // Session ended / was torn down while we were connecting.
        session.abort()
        return
      }
      asrSession = session
      asrPendingSetup = false
      // Burst-feed everything captured while connecting. Deepgram decodes
      // faster than real time, so it catches up within a few hundred ms.
      for (const frame of asrBacklog) session.sendFrame(frame)
      asrBacklog = []
      log.info(`[timing] asr session live at +${Date.now() - t0}ms`)
    })
    .catch((err) => {
      if (mySession !== sessionId) return
      // Includes quota (402 at mint): stay silent here — the batch path
      // enforces the same quota and surfaces the same message when it runs,
      // so the user gets exactly one consistent error.
      log.info(
        `[timing] asr fallback reason=${asrErrorCode(err) ?? 'setup-failed'} ` +
          `detail=${(err as Error).message}`,
      )
      teardownAsrStream('setup-failed')
    })
}

/** Start a dictation whose transcript will be transformed by `commandId`'s
 *  prompt (e.g. spoken rough notes → composed email) before pasting. */
export function startCommandRecording(commandId: string): Promise<void> {
  return enqueue(async () => {
    if (state !== 'idle') {
      broadcast('recording-busy', state)
      return
    }
    // forCommand=true keeps streaming OFF: a command dictation's formatting
    // IS the command prompt, so the stream path's format flow doesn't apply.
    await doStart(true)
    // Only arm the command if the recorder actually started (doStart resets
    // pendingCommandId, so set it after). getRecordingState() rather than a
    // direct read: TS narrows `state` to 'idle' across the await otherwise.
    if (getRecordingState() === 'recording') pendingCommandId = commandId
  })
}

export function getRecordingState(): RecordingState {
  return state
}

export function onRecordingStateChange(cb: (s: RecordingState) => void): () => void {
  listeners.push(cb)
  return () => {
    listeners = listeners.filter((l) => l !== cb)
  }
}

function setState(next: RecordingState): void {
  if (state === next) return
  log.info(`[recording] ${state} -> ${next}`)
  state = next
  if (next === 'idle') releaseMedia('dictation')
  for (const cb of listeners) {
    try {
      cb(next)
    } catch (err) {
      log.warn('Recording state listener threw', err)
    }
  }
}

function broadcast(channel: string, payload?: unknown): void {
  if (
    channel === 'transcription-complete' &&
    payload &&
    typeof payload === 'object' &&
    (payload as { protocolVersion?: unknown }).protocolVersion === 2
  ) {
    const trusted = BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && isOriginTrusted(win.webContents.getURL()),
    )
    if (trusted) trusted.webContents.mainFrame.send(channel, payload)
    return
  }
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

// Crash recovery: bump the session id so any in-flight async op sees it
// no longer owns the session and bails before mutating state. Force-idle
// is then driven through the same queue so it can't race with doStop /
// processAudio.
onRecorderCrash((reason) => {
  if (state === 'idle') return
  log.error(`[recording] recorder crash: ${reason}`)
  sessionId++ // invalidate any in-flight session
  // The PCM source just died with the renderer — close the Deepgram socket
  // now instead of letting it idle out on the server's timeout.
  teardownAsrStream('recorder-crash')
  void enqueue(async () => {
    broadcast('transcription-error', 'Recorder crashed — please try again.')
    broadcast('processing-complete')
    focusTarget = null
    recordingAuthContext = null
    recordingGenerationPromise = Promise.resolve(0)
    pendingCommandId = null
    setState('idle')
  })
})

// 10-min-cap initiated stop: the recorder hit its absolute max-duration
// safety ceiling and has buffered the blob. Drive a normal stop through the
// queue. (Silence-driven VAD auto-stop was removed — see src/recorder/recorder.ts.)
onAutoStop(() => {
  void enqueue(async () => {
    if (state === 'recording') {
      await doStop()
    }
  })
})

/** Enqueue an operation so only one runs at a time. */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(() => op())
  // ensure the chain doesn't reject permanently
  opChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function toggleRecording(): Promise<void> {
  return enqueue(async () => {
    switch (state) {
      case 'idle':
        await doStart()
        return
      case 'recording':
        await doStop()
        return
      case 'starting':
      case 'stopping':
      case 'processing':
        // Provide visible feedback but don't change state.
        broadcast('recording-busy', state)
        return
    }
  })
}

export function startRecording(): Promise<void> {
  return enqueue(async () => {
    if (state !== 'idle') {
      broadcast('recording-busy', state)
      return
    }
    await doStart()
  })
}

export function stopRecording(): Promise<void> {
  return enqueue(async () => {
    if (state !== 'recording') {
      broadcast('recording-busy', state)
      return
    }
    await doStop()
  })
}

async function doStart(forCommand = false): Promise<void> {
  const t0 = Date.now()
  if (!tryAcquireMedia('dictation')) {
    broadcast('transcription-error', 'Stop the screen recording before starting dictation.')
    return
  }
  // If a transform is mid-flight (LLM call resolving), abort it so its
  // delayed Ctrl+V doesn't fire into a now-active recording context.
  abortInFlightTransform()
  // Same for an in-flight smart-formatting pass on a prior transcription.
  abortInFlightFormat()
  // Belt + braces: doStop always clears streaming state, but a leftover
  // socket from an abnormal path must never receive a new session's audio.
  teardownAsrStream('superseded-by-new-start')
  const mySession = ++sessionId
  recordingAuthContext = getAuthContext()
  recordingGenerationPromise = recordingAuthContext
    ? getDeletionGeneration(recordingAuthContext.ownerId)
    : Promise.resolve(0)
  // A plain F11 dictation must never inherit a command from a previous
  // session; startCommandRecording re-arms this after doStart returns.
  pendingCommandId = null
  setState('starting')

  const settings = getSettings()
  // Tell the overlay to appear immediately — don't wait for the recorder
  // ACK. The overlay will show "Starting…" until 'recording-started' fires.
  // Suppress entirely if the user disabled the overlay in settings.
  if (settings.showOverlay) {
    broadcast('recording-starting')
    log.info(`[timing] recording-starting broadcast at +${Date.now() - t0}ms`)
  }

  // Capture the focus target BEFORE we start the recorder window (which
  // could itself momentarily affect z-order on some platforms). This is
  // the window we'll paste into after transcription completes.
  const target = await captureFocusTarget()
  if (mySession !== sessionId) {
    log.info('[recording] doStart abandoned — session invalidated')
    return
  }
  focusTarget = target
  log.info(`[timing] captureFocusTarget done at +${Date.now() - t0}ms`)

  // Note: startRecorderSession lazy-inits the recorder window if it isn't
  // already up, so we don't reject on isRecorderHealthy() === false here.
  //
  // needPcm mirrors transcribe.ts's mode resolution (env override wins over
  // the setting): the recorder only spends 200-600 ms decoding the blob to
  // 16 kHz PCM at stop time when on-device Whisper will actually consume it.
  // Cloud sessions skip the decode; the rare cloud-unreachable → local
  // fallback re-requests PCM on demand ('recorder:decode-pcm').
  const transcriptionMode =
    process.env.SPEAKFLOW_TRANSCRIPTION_MODE || settings.transcriptionMode

  // ── True Streaming eligibility ────────────────────────────────────────────
  // Opt-in engine + cloud mode + a proxy to mint grants against + a live JWT
  // + English (Nova-3 streaming is en-validated only; filler-strip is
  // English-only too) + not a command dictation (its formatting IS the
  // command prompt). Anything ineligible runs the exact pre-streaming flow.
  const streamEligible =
    settings.streamingEngine === 'deepgram' &&
    transcriptionMode === 'cloud' &&
    !!getProxyBaseUrl() &&
    !!getAuthToken() &&
    settings.language.startsWith('en') &&
    !forCommand

  // Open the Deepgram socket IN PARALLEL with the recorder start — never
  // awaited: hotkey → 'recording-started' latency is sacred, and beginAsr-
  // Stream handles every outcome through session-guarded continuations.
  if (streamEligible) {
    beginAsrStream(mySession, t0)
  }

  try {
    await startRecorderSession({
      microphoneId: settings.microphone,
      needPcm: transcriptionMode === 'local',
      streamPcm: streamEligible,
    })
  } catch (err) {
    const msg = (err as Error).message
    log.error('[recording] start failed', err)
    teardownAsrStream('recorder-start-failed') // no recorder → no PCM → no stream
    broadcast('transcription-error', humanizeStartError(msg))
    focusTarget = null
    recordingAuthContext = null
    recordingGenerationPromise = Promise.resolve(0)
    setState('idle')
    return
  }

  if (mySession !== sessionId) {
    log.info('[recording] doStart abandoned post-recorder — session invalidated')
    return
  }
  setState('recording')
  recordingStartedAt = Date.now()
  broadcast('recording-started')
  log.info(`[timing] recording-started at +${Date.now() - t0}ms`)
  if (settings.dictationSounds) playSound('start')
}

async function doStop(): Promise<void> {
  const t0 = Date.now()
  const mySession = sessionId
  const authContext = recordingAuthContext
  const deletionGeneration = await recordingGenerationPromise.catch(() => 0)
  // Audio duration = hotkey-to-hotkey, measured from the recorder's start
  // ACK. Captured here, before any network round-trips inflate the clock.
  const durationSeconds =
    recordingStartedAt > 0 ? Math.round((Date.now() - recordingStartedAt) / 1000) : 0
  setState('stopping')
  broadcast('recording-stopped')
  log.info(`[timing] recording-stopped broadcast at +${Date.now() - t0}ms`)

  const settings = getSettings()
  if (settings.dictationSounds) playSound('stop')

  // The click/hotkey changes the UI immediately, but audio capture is allowed
  // to drain for one short tail window before either pipeline is closed. This
  // preserves the final word when Stop lands immediately after the speaker's
  // last syllable. Both the MediaRecorder fallback and live Deepgram stream
  // remain open during this wait, so they end at the same audio boundary.
  await waitForStopTail()

  // ── True Streaming: flush Deepgram IN PARALLEL with the blob collection ──
  // finalize() sends the Finalize control message immediately; its promise is
  // pre-settled into a {text|failure} shape so Promise semantics can never
  // let a stream failure reject past the batch path (allSettled-by-hand).
  // The MediaRecorder blob below is ALWAYS collected regardless — it is the
  // complete-audio fallback for every streaming failure mode.
  const streamSession = asrSession
  const tFinalize = Date.now()
  const finalizeSettled: Promise<{
    result: AsrFinalizeResult | null
    failure: string | null
  }> | null = streamSession
    ? streamSession.finalize().then(
        (result) => ({ result, failure: null }),
        (err: unknown) => ({
          result: null,
          failure: `${asrErrorCode(err) ?? 'unknown'} (${(err as Error).message})`,
        }),
      )
    : null

  let audioBuffer: Buffer | null = null
  let audioPcm: Float32Array | null = null
  let speechMs: number | null = null
  let peakLevel: number | null = null
  let stopToBlobMs = 0
  try {
    const result = await stopRecorderSession()
    audioBuffer = result.audio
    audioPcm = result.pcm
    speechMs = result.speechMs
    peakLevel = result.peakLevel
    stopToBlobMs = Date.now() - t0
    log.info(
      `[timing] audio blob received at +${stopToBlobMs}ms (${audioBuffer?.byteLength ?? 0} bytes, ` +
        `pcm=${audioPcm ? audioPcm.length : 0} samples, speechMs=${speechMs ?? 'n/a'}, peak=${peakLevel?.toFixed(3) ?? 'n/a'})`,
    )
  } catch (err) {
    log.error('[recording] stop failed', err)
    teardownAsrStream('recorder-stop-failed')
    if (mySession !== sessionId) return
    broadcast('transcription-error', 'Could not finalise the recording.')
    broadcast('processing-complete')
    focusTarget = null
    recordingAuthContext = null
    recordingGenerationPromise = Promise.resolve(0)
    setState('idle')
    return
  }

  // Collect the parallel flush. Bounded by finalize()'s own 2 s internal
  // timeout, and mostly overlapped with the blob wait above, so the stream
  // path's stop→text cost is ~the finalize RTT (~300 ms), not additive.
  let streamText: string | null = null
  let streamMs = 0
  if (finalizeSettled) {
    const settled = await finalizeSettled
    streamMs = Date.now() - tFinalize
    if (settled.failure) {
      log.info(`[timing] asr fallback reason=finalize-failed detail=${settled.failure}`)
    } else if (!settled.result || !settled.result.text.trim()) {
      // Socket lived but heard nothing usable — batch gets the final say.
      log.info('[timing] asr fallback reason=empty-stream-transcript')
    } else if (isStreamTruncated(settled.result)) {
      // Deepgram committed words for materially less audio than we sent: the
      // flush settled while it was still decoding the tail, so the last words
      // are MISSING. Reported by Thys as "sometimes it cuts out at the end"
      // and confirmed 2026-07-29 (shadow diff 22.6%: 68 streamed chars vs 111
      // heard by the batch engine on the same clip). The MediaRecorder audio
      // below is complete — spend the extra ~1 s and get the whole sentence.
      const { coveredMs, audioSentMs } = settled.result
      log.warn(
        `[timing] asr fallback reason=truncated-stream ` +
          `covered=${Math.round(coveredMs)}ms sent=${audioSentMs}ms ` +
          `missing=${Math.round(audioSentMs - coveredMs)}ms`,
      )
    } else {
      streamText = settled.result.text
    }
  }
  // The session is spent either way (finalize closes the socket); release
  // the PCM handlers/backlog before processing begins.
  teardownAsrStream('stopped')

  if (mySession !== sessionId) {
    log.info('[recording] doStop abandoned post-blob — session invalidated')
    return
  }

  setState('processing')
  broadcast('processing-started')
  log.info(`[timing] processing-started at +${Date.now() - t0}ms`)

  // Empty blob = the recorder's own gates dropped the clip (too short /
  // whole-session silence) — nothing to process.
  if (!audioBuffer || audioBuffer.byteLength === 0) {
    broadcast('processing-complete')
    focusTarget = null
    recordingAuthContext = null
    recordingGenerationPromise = Promise.resolve(0)
    setState('idle')
    return
  }

  await processAudio(audioBuffer, audioPcm, settings.language, mySession, {
    durationSeconds,
    speechMs,
    peakLevel,
    stopStartedAt: t0,
    stopToBlobMs,
    streamText,
    streamMs,
    authContext,
    deletionGeneration,
  })
}

// Collapse Whisper hallucination loops — e.g. "word word word word" or
// "the cat sat the cat sat the cat sat". Scans for any word-sequence of
// length 1–8 that repeats consecutively and keeps only one copy.
function collapseRepetitions(text: string): string {
  const words = text.split(/\s+/).filter(Boolean)
  for (let span = 1; span <= Math.min(8, Math.floor(words.length / 2)); span++) {
    for (let i = 0; i < words.length - span; ) {
      const window = words.slice(i, i + span).join(' ').toLowerCase()
      let j = i + span
      while (
        j + span <= words.length &&
        words.slice(j, j + span).join(' ').toLowerCase() === window
      ) {
        j += span
      }
      if (j > i + span) {
        words.splice(i + span, j - (i + span))
      }
      i++
    }
  }
  return words.join(' ')
}

// Everything doStop measured/knows about the finished clip — one bag so the
// processAudio signature doesn't sprawl.
interface StopStats {
  durationSeconds: number
  // Speech-energy stats from the recorder's level monitor. null = monitor
  // never ran (no AudioContext) → every gate keyed on them fails OPEN.
  speechMs: number | null
  peakLevel: number | null
  // Date.now() at doStop entry — anchor for the summary's total.
  stopStartedAt: number
  stopToBlobMs: number
  // True Streaming: the finalized Deepgram transcript, or null when the
  // session didn't stream / the flush failed / it came back empty — in which
  // case processAudio transcribes the blob exactly as before streaming existed.
  streamText: string | null
  // How long doStop waited on the flush — becomes 'transcribe' in the summary
  // when the stream path wins.
  streamMs: number
  authContext: AuthContext | null
  deletionGeneration: number
}

async function processAudio(
  buffer: Buffer,
  pcm: Float32Array | null,
  language: string,
  mySession: number,
  stats: StopStats,
): Promise<void> {
  // ── Per-session timing ledger (work item A) ──────────────────────────────
  // Exactly ONE summary line per processed clip — success, failure, or drop —
  // so latency distributions can be rebuilt from user logs with a single
  // grep for '[timing] summary'. total = doStop entry → inject resolved (or
  // the failure point when the pipeline never reached inject).
  let path: 'dictate' | 'legacy' | 'local' | 'stream' = 'legacy'
  let transcribeMs = 0
  let formatMs: number | null = null // null renders as 'skip'
  let injectMs = 0
  let ok = false
  let endedAt = 0

  try {
    // ── Speech-seconds gate (work item E) ───────────────────────────────────
    // Runs BEFORE any network call: a clip with <400 ms of speech-level audio
    // is noise, and sending it to Whisper both hallucinates ("invented
    // sentences / swear words on silent-room clips") and bills 10 s minimum.
    // Same user feedback as the empty-transcription path so the UX is one
    // consistent "No speech detected". Fail open on null (no level reading).
    if (stats.speechMs !== null && stats.speechMs < MIN_SPEECH_MS) {
      log.info(
        `[recording] speech gate dropped clip: speechMs=${stats.speechMs} < ${MIN_SPEECH_MS} ` +
          `(peak=${stats.peakLevel?.toFixed(3) ?? 'n/a'}, ${buffer.byteLength}B) — proxy not called`,
      )
      broadcast('transcription-error', 'No speech detected — try speaking louder or closer to the mic')
      return
    }

    // Read settings live so a mid-recording toggle is honored, and resolve
    // everything the routing decision needs up front.
    const liveSettings = getSettings()
    const lang = language === 'auto' ? undefined : language
    const targetSnapshot = focusTarget // captured at hotkey time; cleared by finally
    // Claim the pending command before routing: command dictations must keep
    // the classic transcribe→transform pipeline (their formatting IS the
    // command prompt), so they never take the /dictate path.
    const commandId = pendingCommandId
    pendingCommandId = null
    const command = commandId ? getCommand(commandId) : undefined

    const transcriptionMode =
      process.env.SPEAKFLOW_TRANSCRIPTION_MODE || liveSettings.transcriptionMode
    const proxyBase = getProxyBaseUrl()
    if (transcriptionMode === 'local') path = 'local'

    // /dictate route (work item D): ONE proxy round-trip does Whisper + the
    // server-side hallucination filter + formatting. Only for the plain
    // cloud+Groq dictation flow:
    //   - local mode keeps on-device Whisper (+ its own cloud fallback);
    //   - Deepgram users keep the legacy path — /dictate is Groq-only per
    //     the frozen contract, and silently switching their engine would be
    //     worse than one extra round-trip;
    //   - dev builds without a proxy keep the direct-Groq legacy path;
    //   - command dictations keep transcribe→transformText untouched.
    const useDictate = transcriptionMode === 'cloud' && !!proxyBase

    // True Streaming result from doStop's parallel finalize. Command guard is
    // belt + braces — doStart already refuses streaming for command sessions,
    // but a command must NEVER consume a stream transcript: its transform
    // pipeline expects to own all formatting.
    const streamText =
      !command && stats.streamText && stats.streamText.trim() ? stats.streamText.trim() : null

    // Token rotation guard: every cloud path needs a JWT, and if the hotkey
    // lands in the seconds around a Supabase refresh there momentarily isn't
    // one — which used to destroy the whole recording ("Sign in via the
    // dashboard", 81 s of speech lost, 2026-07-29). Wait a beat for the
    // renderer to push the refreshed session before committing to that fate.
    // The owner is captured at hotkey press. A refreshed JWT may replace the
    // captured token only when it belongs to that same owner.
    let operationAuth = stats.authContext
    if (transcriptionMode !== 'local' && proxyBase) {
      let current = getAuthContext()
      if (!current && operationAuth) {
        await ensureAuthToken()
        current = getAuthContext()
      }
      if (current && operationAuth && current.ownerId === operationAuth.ownerId) {
        operationAuth = current
      }
      if (!operationAuth) {
        log.warn('[recording] no captured auth owner for this dictation')
        throw new Error('Sign in via the dashboard to use Speakflow.')
      }
      if (mySession !== sessionId) {
        log.info('[recording] abandoned during auth wait — session invalidated')
        return
      }
    }

    let rawText: string | null = null
    let serverFormatted: string | undefined
    let usageEventId: string | null = null
    let eventEngine = path === 'local' ? 'local-whisper' : 'deepgram-nova-3'

    if (streamText) {
      // Stream path: the transcript is already here — no upload, no proxy
      // round-trip. From this point it flows through the IDENTICAL post-
      // pipeline as a legacy transcript: collapse → filler-strip → empty
      // guard → shouldFormat/formatTranscript (+ sanityCheck) → snippets →
      // inject. serverFormatted stays undefined on purpose so the local
      // format branch below applies its usual skip-gate (Deepgram's
      // smart_format already punctuated; short clips skip the LLM pass).
      path = 'stream'
      rawText = streamText
      transcribeMs = stats.streamMs
    } else if (useDictate) {
      path = 'dictate'
      const tDictate = Date.now()
      try {
        const res = await dictateViaProxy(buffer, {
          authToken: operationAuth?.token ?? '',
          deletionGeneration: stats.deletionGeneration,
          language: lang,
          format: !command && liveSettings.enableSmartFormatting,
          stripDisfluencies: liveSettings.stripDisfluencies,
          appName: targetSnapshot?.processName ?? undefined,
          windowTitle: targetSnapshot?.title ?? undefined,
          dictionary: getDictionaryWords(),
          speechMs: stats.speechMs,
        })
        const rtt = Date.now() - tDictate
        // Single-RTT split for the summary: the server reports its format
        // stage; everything else (network + auth + quota + body + Groq) is
        // attributed to 'transcribe'. The full server breakdown is logged
        // separately by dictate.ts ('[timing] dictate server ...').
        const serverFormatMs = res.serverTimings?.formatMs ?? 0
        transcribeMs += Math.max(0, rtt - serverFormatMs)
        formatMs = serverFormatMs > 0 ? serverFormatMs : null
        rawText = res.raw
        usageEventId = res.usageEventId
        eventEngine = `${res.provider}-${res.model}`
        if (!res.skipped) serverFormatted = res.formatted
      } catch (err) {
        const wasted = Date.now() - tDictate
        transcribeMs += wasted
        // v0.8 never retries via the unmetered legacy endpoint. The server
        // owns ASR fallback and succeeds only after the one atomic charge.
        log.warn(`[dictate] failed after ${wasted}ms: ${(err as Error).message}`)
        throw err
      }
    }

    if (rawText === null) {
      // Legacy / local / command path — the pre-Fast-Batch pipeline.
      // Pass buffer directly — no disk round-trip. Previously we wrote a temp
      // file then transcribe.ts stat+read it back, wasting ~30-50 ms.
      const tTranscribe = Date.now()
      rawText = await transcribeAudio(buffer, {
        language: lang,
        pcm,
        speechMs: stats.speechMs,
      })
      transcribeMs += Date.now() - tTranscribe
      eventEngine = path === 'local' ? 'local-whisper' : 'legacy-cloud'
    }

    if (mySession !== sessionId) {
      log.info('[recording] processAudio abandoned — session invalidated (sign-out or crash)')
      return
    }

    // ── Silence-artifact blocklist (work item E) ─────────────────────────────
    // Right after transcription, before any formatting, on BOTH paths: if the
    // whole transcript is a classic Whisper silence hallucination ("Thanks
    // for watching", "Dankie dat jy gekyk het", …) AND the clip carried
    // under 1.5 s of measured speech, treat it as empty. The server filters
    // these on the dictate path too — this client copy covers legacy/dev/
    // local, and costs microseconds.
    if (
      rawText.trim() &&
      stats.speechMs !== null &&
      stats.speechMs < ARTIFACT_MAX_SPEECH_MS &&
      isSilenceArtifact(rawText)
    ) {
      log.warn(
        `[recording] silence-artifact transcript dropped (speechMs=${stats.speechMs}): ` +
          `"${rawText.trim().slice(0, 80)}"`,
      )
      rawText = ''
      serverFormatted = undefined
    }

    // Pronunciation-trained corrections (v0.7.0): replace known mis-hearings
    // ("tice") with the intended spelling ("Thys"). ONE site covers all four
    // paths (stream/dictate/legacy/local) plus command dictations. Applied to
    // BOTH texts so the sanityCheck word-overlap comparison below stays
    // apples-to-apples — correcting only one side would skew it.
    if (rawText) {
      rawText = applyPronunciationAliases(rawText)
      if (serverFormatted) serverFormatted = applyPronunciationAliases(serverFormatted)
    }

    if (!rawText || !rawText.trim()) {
      // Whisper returned empty — only show feedback if the clip was substantial
      // (short accidental presses stay silent).
      if (buffer.byteLength > 15_000) {
        log.warn(`[recording] empty transcription for ${buffer.byteLength}B clip`)
        broadcast('transcription-error', 'No speech detected — try speaking louder or closer to the mic')
      }
    } else {
      let rawTrimmed = collapseRepetitions(rawText.trim())
      // Instant filler removal (um/uh/ah) on EVERY clip — the LLM pass
      // skips short dictations, so this is what keeps a 10-word sentence
      // clean. English-only: "um" is a real word in other languages. Applied
      // to the RAW text on the dictate path too: it feeds the sanity check,
      // the word count, and the fallback text if the server formatting is
      // rejected below.
      if (liveSettings.stripDisfluencies && language.startsWith('en')) {
        rawTrimmed = stripFillerWords(rawTrimmed)
      }

      // Post-processing can legitimately EMPTY the transcript: Whisper loop-
      // hallucinates "um um um…" on a noise clip → collapseRepetitions leaves
      // "um" → stripFillerWords leaves "". Without this recheck the empty
      // string reached the transform proxy (400 "userText required",
      // observed 2026-07-16) and injectText. Same UX as an empty transcription.
      if (!rawTrimmed) {
        log.warn('[recording] transcript empty after collapse/filler-strip — treating as no speech')
        broadcast('transcription-error', 'No speech detected — try speaking louder or closer to the mic')
        return
      }
      let trimmed = rawTrimmed

      // Command dictation (Ctrl+Shift+N with nothing highlighted): run the
      // transcript through the command's prompt — e.g. spoken rough notes
      // become a composed email. Fail-open to the raw transcript.
      if (command) {
        broadcast('transform-starting')
        try {
          const transformed = await transformText(
            command.prompt + toneInstruction(command.tone),
            rawTrimmed,
            command.model,
          )
          if (mySession !== sessionId) {
            log.info('[recording] command result discarded — session invalidated')
            return
          }
          trimmed = transformed
        } catch (err) {
          log.warn(`[recording] command "${command.name}" failed — pasting raw transcript`, err)
          if (mySession !== sessionId) return
          broadcast('transcription-error', `${command.name} failed — pasted the raw transcript instead.`)
        }
      }

      if (!command && serverFormatted) {
        // Dictate path, server formatted: the SAME shared decision helper as
        // the local formatter below — a server-side LLM can answer-instead-of-
        // reformat just as easily as a local call, and a changed invoice
        // number or a dropped "not" must fall back to raw on either route.
        // collapseRepetitions deliberately ran on raw only; if Whisper
        // loop-hallucinated, the un-collapsed formatted text fails the
        // length-ratio check inside and we fall back to the collapsed raw.
        // Fail-open to rawTrimmed, never re-format.
        const decision = decideFormattedText(
          'server-formatted',
          rawTrimmed,
          serverFormatted,
          getDictionaryWords(),
        )
        trimmed = decision.text
      } else if (
        !command &&
        path !== 'dictate' &&
        liveSettings.enableSmartFormatting &&
        shouldFormat(rawTrimmed)
      ) {
        // Legacy/local path only. On the dictate path a server "skip" is
        // final — re-running formatting locally would re-add the exact
        // second LLM round-trip Fast Batch removed. Fail-open: any error or
        // aborted call falls back to the raw text — the user must never
        // lose their dictation here.
        const tFormat = Date.now()
        try {
          const formatted = await formatTranscript(rawTrimmed, {
            stripDisfluencies: liveSettings.stripDisfluencies,
            dictionaryWords: getDictionaryWords(),
            appName: targetSnapshot?.processName ?? null,
            windowTitle: targetSnapshot?.title ?? null,
          })
          formatMs = Date.now() - tFormat
          if (mySession !== sessionId) {
            log.info('[recording] format result discarded — session invalidated')
            return
          }
          // Same shared decision helper as the server-formatted route above:
          // statistical sanity gate, then the deterministic preservation
          // guard (numbers, emails, URLs, negations, dictionary terms).
          const decision = decideFormattedText(
            'local-format',
            rawTrimmed,
            formatted,
            getDictionaryWords(),
          )
          trimmed = decision.text
        } catch (err) {
          formatMs = Date.now() - tFormat
          log.warn('[format] failed, falling back to raw', err)
        }
      }

      // Snippet expansion — replace standalone trigger phrases with their
      // expansions ("my address" → the full address). After formatting so
      // the LLM never sees/rewrites the expansion; before inject so the
      // pasted text is the expanded one.
      trimmed = expandSnippets(trimmed)

      // Wispr-parity: a trailing period on a short single-line chat message
      // reads as curt in Slack/WhatsApp/Teams — drop exactly one. "?" "!" and
      // "..." are meaningful and stay. Deterministic (no LLM), messaging
      // category only, so emails and documents keep their full stops.
      if (
        trimmed.length < 200 &&
        !trimmed.includes('\n') &&
        /[^.!?]\.$/.test(trimmed) &&
        detectContextCategory(targetSnapshot?.processName, targetSnapshot?.title) === 'messaging'
      ) {
        trimmed = trimmed.slice(0, -1)
      }

      // Inject FIRST so the paste isn't delayed by anything else.
      const tInject = Date.now()
      let injectResult
      try {
        injectResult = await injectText(trimmed, targetSnapshot)
      } catch (injectErr) {
        log.error('[recording] injection threw', injectErr)
        injectResult = { ok: false, method: 'clipboard' as const, error: 'inject-threw' }
      }
      injectMs = Date.now() - tInject
      endedAt = Date.now() // summary total anchors here: inject resolved
      ok = injectResult.ok
      if (mySession !== sessionId) {
        log.info('[recording] post-inject broadcast skipped — session invalidated')
        return
      }
      let persisted = false
      let clientEventId = usageEventId
      if (path !== 'dictate') {
        if (!operationAuth) {
          throw new Error('Sign in via the dashboard to save this dictation.')
        }
        const committed = await reportStreamingUsage({
          ownerId: operationAuth.ownerId,
          authToken: operationAuth.token,
          text: trimmed,
          audioSeconds: stats.durationSeconds,
          durationSeconds: stats.durationSeconds,
          engine: eventEngine,
          source: path === 'local' ? 'local' : 'streaming',
          appContext: targetSnapshot?.processName ?? null,
          deletionGeneration: stats.deletionGeneration,
        })
        persisted = committed.persisted
        usageEventId = committed.usageEventId
        clientEventId = committed.clientEventId
        if (!committed.persisted && !committed.queued) {
          log.warn('[metering] event could not be committed or encrypted locally')
        }
      }

      // Persisted local/stream events already have a history row. Admitted
      // batch events carry the canonical usage id and let the compatibility
      // writer insert their history row exactly once.
      if (path === 'dictate' || persisted) {
        broadcast('transcription-complete', {
          protocolVersion: 2,
          text: trimmed,
          durationSeconds: stats.durationSeconds,
          appName: targetSnapshot?.processName ?? null,
          windowTitle: targetSnapshot?.title ?? null,
          source: command ? 'transform' : 'dictation',
          clientEventId,
          usageEventId,
          deletionGeneration: stats.deletionGeneration,
          persisted,
        })
      }
      if (!injectResult.ok) {
        broadcast('transcription-error', humanizeInjectError(injectResult.error ?? ''))
      }

      // Background sync to Supabase knowledge base (RAG index). Deferred to
      // setImmediate so the CPU-bound embedding step never delays paste —
      // by this point the user already saw their text appear.
      if (operationAuth) {
        setImmediate(() => {
          syncToKnowledgeBase(trimmed, operationAuth.ownerId, {
            window_title: targetSnapshot?.title ?? null,
            app_name: targetSnapshot?.processName ?? null,
            word_count: rawTrimmed.split(/\s+/).filter(Boolean).length,
          }).catch((err) => log.error('[sync] knowledge-base sync failed', err))
        })
      }

      if (path === 'stream') {
        // Shadow compare (rollout diagnostics): re-run the batch engine on
        // the same blob in the background and log a word-level diff ratio —
        // the data that decides whether streamingEngine can default on.
        // Runs strictly AFTER inject; never affects what the user got.
        if (liveSettings.asrShadowCompare && streamText) {
          log.info('[asr-shadow] skipped: admitted v0.8 requests are never duplicated')
        }
      }
    }
  } catch (err) {
    log.error('[recording] transcription failed', err)
    if (mySession === sessionId) {
      broadcast('transcription-error', humanizeTranscribeError(err as Error))
    }
  } finally {
    // Work item A: the one-line-per-session latency summary. Emitted before
    // the state reset so 'total' isn't inflated by listener work; endedAt
    // falls back to now for failure/drop paths that never reached inject.
    const totalMs = (endedAt || Date.now()) - stats.stopStartedAt
    log.info(
      `[timing] summary sid=${mySession} path=${path} lang=${language} ` +
        `audio=${stats.durationSeconds}s bytes=${buffer.byteLength} ` +
        `stopToBlob=${stats.stopToBlobMs} transcribe=${transcribeMs} ` +
        `format=${formatMs ?? 'skip'} inject=${injectMs} total=${totalMs} ok=${ok}`,
    )
    // Only mutate terminal state if we still own this session.
    if (mySession === sessionId) {
      broadcast('processing-complete')
      focusTarget = null
      recordingAuthContext = null
      recordingGenerationPromise = Promise.resolve(0)
      setState('idle')
    }
  }
}

/** Called from the auth handler on sign-out — invalidates the current session
 *  so any in-flight transcription/inject won't fire, and tears the state
 *  machine back to idle without waiting for the recorder. */
export function abortInFlightRecording(reason: string): void {
  if (state === 'idle') return
  log.info(`[recording] abort requested: ${reason}`)
  sessionId++
  abortInFlightFormat()
  // Sign-out must kill the live audio socket immediately: the grant token
  // belongs to the departing identity and mic audio must stop leaving the
  // machine the moment the session is invalidated.
  teardownAsrStream(`abort: ${reason}`)
  void enqueue(async () => {
    broadcast('recording-stopped')
    broadcast('processing-complete')
    focusTarget = null
    recordingAuthContext = null
    recordingGenerationPromise = Promise.resolve(0)
    pendingCommandId = null
    setState('idle')
  })
}

// ── User-facing error messages ─────────────────────────────────────────────
function humanizeStartError(msg: string): string {
  if (msg.includes('mic-permission')) return 'Microphone access is blocked. Grant it in System Settings.'
  if (msg.includes('recorder-init')) return 'Your microphone is unavailable. Try a different input.'
  if (msg.includes('ready-timeout')) return 'Recorder did not start in time. Try again.'
  return 'Could not start recording.'
}
function humanizeTranscribeError(err: Error): string {
  if (err.message.startsWith('GROQ_API_KEY')) return err.message
  if (err.message.includes('Weekly free limit')) return err.message
  if (err.message.includes('25 MB')) return 'Recording too long. Try a shorter clip.'
  if (err.message.includes('Sign in')) return 'Please sign in to use Speakflow.'
  if (err.message.toLowerCase().includes('timeout')) return 'Transcription timed out. Check your connection.'
  return 'Transcription failed. Try again.'
}
function humanizeInjectError(reason: string): string {
  if (reason === 'no-keyboard-backend') {
    return 'Text copied to clipboard — paste manually (keyboard backend unavailable).'
  }
  if (reason === 'self-window-focused') {
    return 'Text copied to clipboard — Speakflow itself had focus. Click into your editor and press Ctrl+V.'
  }
  if (reason === 'no-target') {
    return 'Text copied to clipboard — could not identify a target window. Press Ctrl+V to paste.'
  }
  if (reason === 'paste-failed') {
    return 'Paste failed. The text is on your clipboard — press Ctrl+V manually.'
  }
  return 'Could not paste the transcribed text.'
}

/** Force a clean shutdown — used by `before-quit`. */
export async function shutdownRecording(): Promise<void> {
  if (state === 'idle') return
  log.info('[recording] shutdown requested while ' + state)
  sessionId++ // invalidate any in-flight session
  abortInFlightFormat()
  teardownAsrStream('shutdown')
  try {
    if (state === 'recording') {
      await Promise.race([
        stopRecorderSession().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
    }
  } finally {
    focusTarget = null
    recordingAuthContext = null
    recordingGenerationPromise = Promise.resolve(0)
    pendingCommandId = null
    setState('idle')
  }
}
