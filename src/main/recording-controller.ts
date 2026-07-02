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
  onPartialSegment,
} from './recorder'
import { transcribeAudio } from './transcribe'
import { syncToKnowledgeBase } from './supabase'
import { getAuthToken } from './ipc'
import { injectText, captureFocusTarget, WindowSnapshot } from './inject'
import { getSettings } from './settings'
import { playSound } from './sound'
import { abortInFlightTransform } from './transform-controller'
import {
  formatTranscript,
  shouldFormat,
  sanityCheck,
  stripFillerWords,
  abortInFlightFormat,
} from './format-transcript'
import { getCommand } from './commands-store'
import { transformText } from './transform-llm'

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

export function getPendingCommandId(): string | null {
  return pendingCommandId
}

// ── Streaming transcription ────────────────────────────────────────────────
// While the user is still talking, the recorder ships pause-delimited audio
// segments; each is transcribed here in the background. At stop time only
// the final tail still needs transcribing, then all texts join in order.
interface SegmentJob {
  audio: Buffer
  pcm: Float32Array | null
  promise: Promise<string>
  failed: boolean
}
let segments: Array<SegmentJob | undefined> = []
// Language captured at doStart so background segment jobs and the tail all
// use the same setting even if the user changes it mid-recording.
let sessionLanguage: string | undefined

onPartialSegment(({ index, audio, pcm }) => {
  if (state !== 'recording' && state !== 'stopping') {
    log.warn(`[recording] partial segment ${index} ignored (state=${state})`)
    return
  }
  const job: SegmentJob = { audio, pcm, failed: false, promise: Promise.resolve('') }
  job.promise = transcribeAudio(audio, { language: sessionLanguage, pcm }).catch((err) => {
    log.warn(`[recording] segment ${index} failed — will retry at stop`, err)
    job.failed = true
    return ''
  })
  segments[index] = job
  log.info(`[recording] segment ${index} (${audio.byteLength}B) transcribing in background`)
})

/** Transcribe the session's audio: single-shot when no partials were
 *  streamed, otherwise await the background jobs and join in order. */
async function transcribeSessionAudio(
  finalBuffer: Buffer,
  finalPcm: Float32Array | null,
  lang: string | undefined,
): Promise<string> {
  const partials = segments
  segments = []
  if (partials.length === 0) {
    return transcribeAudio(finalBuffer, { language: lang, pcm: finalPcm })
  }

  const t0 = Date.now()
  // Kick the tail off in parallel with any still-running partials.
  const tailPromise =
    finalBuffer.byteLength > 0
      ? transcribeAudio(finalBuffer, { language: lang, pcm: finalPcm })
      : Promise.resolve('')

  const parts: string[] = []
  let salvageError: Error | null = null
  for (let i = 0; i < partials.length; i++) {
    const job = partials[i]
    if (!job) continue
    let text = await job.promise
    if (job.failed) {
      try {
        text = await transcribeAudio(job.audio, { language: lang, pcm: job.pcm })
      } catch (err) {
        // Keep the rest of the dictation — losing one segment beats losing all.
        salvageError = err as Error
        text = ''
        log.error(`[recording] segment ${i} failed permanently — skipping`, err)
      }
    }
    parts.push(text)
  }
  parts.push(await tailPromise)

  const joined = parts.map((p) => p.trim()).filter(Boolean).join(' ')
  log.info(`[timing] streaming join: ${partials.length} partial(s) + tail ready in ${Date.now() - t0}ms after stop`)
  if (salvageError) {
    if (!joined) throw salvageError
    broadcast('transcription-error', 'A part of the dictation could not be transcribed.')
  }
  return joined
}

/** Start a dictation whose transcript will be transformed by `commandId`'s
 *  prompt (e.g. spoken rough notes → composed email) before pasting. */
export function startCommandRecording(commandId: string): Promise<void> {
  return enqueue(async () => {
    if (state !== 'idle') {
      broadcast('recording-busy', state)
      return
    }
    await doStart()
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
  for (const cb of listeners) {
    try {
      cb(next)
    } catch (err) {
      log.warn('Recording state listener threw', err)
    }
  }
}

function broadcast(channel: string, payload?: unknown): void {
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
  void enqueue(async () => {
    broadcast('transcription-error', 'Recorder crashed — please try again.')
    broadcast('processing-complete')
    focusTarget = null
    pendingCommandId = null
    segments = []
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

async function doStart(): Promise<void> {
  const t0 = Date.now()
  // If a transform is mid-flight (LLM call resolving), abort it so its
  // delayed Ctrl+V doesn't fire into a now-active recording context.
  abortInFlightTransform()
  // Same for an in-flight smart-formatting pass on a prior transcription.
  abortInFlightFormat()
  const mySession = ++sessionId
  // A plain F11 dictation must never inherit a command from a previous
  // session; startCommandRecording re-arms this after doStart returns.
  pendingCommandId = null
  segments = []
  setState('starting')

  const settings = getSettings()
  sessionLanguage = settings.language === 'auto' ? undefined : settings.language
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
  try {
    await startRecorderSession({
      microphoneId: settings.microphone,
      streaming: settings.streamingTranscription,
    })
  } catch (err) {
    const msg = (err as Error).message
    log.error('[recording] start failed', err)
    broadcast('transcription-error', humanizeStartError(msg))
    focusTarget = null
    setState('idle')
    return
  }

  if (mySession !== sessionId) {
    log.info('[recording] doStart abandoned post-recorder — session invalidated')
    return
  }
  setState('recording')
  broadcast('recording-started')
  log.info(`[timing] recording-started at +${Date.now() - t0}ms`)
  if (settings.dictationSounds) playSound('start')
}

async function doStop(): Promise<void> {
  const t0 = Date.now()
  const mySession = sessionId
  setState('stopping')
  broadcast('recording-stopped')
  log.info(`[timing] recording-stopped broadcast at +${Date.now() - t0}ms`)

  const settings = getSettings()
  if (settings.dictationSounds) playSound('stop')

  let audioBuffer: Buffer | null = null
  let audioPcm: Float32Array | null = null
  try {
    const result = await stopRecorderSession()
    audioBuffer = result.audio
    audioPcm = result.pcm
    log.info(`[timing] audio blob received at +${Date.now() - t0}ms (${audioBuffer?.byteLength ?? 0} bytes, pcm=${audioPcm ? audioPcm.length : 0} samples)`)
  } catch (err) {
    log.error('[recording] stop failed', err)
    if (mySession !== sessionId) return
    broadcast('transcription-error', 'Could not finalise the recording.')
    broadcast('processing-complete')
    focusTarget = null
    setState('idle')
    return
  }

  if (mySession !== sessionId) {
    log.info('[recording] doStop abandoned post-blob — session invalidated')
    return
  }

  setState('processing')
  broadcast('processing-started')
  log.info(`[timing] processing-started at +${Date.now() - t0}ms`)

  // Empty tail is only a no-op when streaming didn't already deliver
  // partial segments — otherwise those still carry the dictation.
  if ((!audioBuffer || audioBuffer.byteLength === 0) && segments.length === 0) {
    broadcast('processing-complete')
    focusTarget = null
    setState('idle')
    return
  }

  await processAudio(audioBuffer ?? Buffer.alloc(0), audioPcm, settings.language, mySession)
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

async function processAudio(
  buffer: Buffer,
  pcm: Float32Array | null,
  language: string,
  mySession: number,
): Promise<void> {
  try {
    // Pass buffer directly — no disk round-trip. Previously we wrote a temp
    // file then transcribe.ts stat+read it back, wasting ~30-50 ms.
    const lang = language === 'auto' ? undefined : language
    const text = await transcribeSessionAudio(buffer, pcm, lang)

    if (mySession !== sessionId) {
      log.info('[recording] processAudio abandoned — session invalidated (sign-out or crash)')
      return
    }

    if (!text || !text.trim()) {
      // Whisper returned empty — only show feedback if the clip was substantial
      // (short accidental presses stay silent).
      if (buffer.byteLength > 15_000) {
        log.warn(`[recording] empty transcription for ${buffer.byteLength}B clip`)
        broadcast('transcription-error', 'No speech detected — try speaking louder or closer to the mic')
      }
    } else if (text.trim()) {
      // Re-read settings live so a mid-recording toggle is honored.
      const liveSettings = getSettings()
      let rawTrimmed = collapseRepetitions(text.trim())
      // Instant filler removal (um/uh/ah) on EVERY clip — the LLM pass below
      // skips short dictations, so this is what keeps a 10-word sentence
      // clean. English-only: "um" is a real word in other languages.
      if (liveSettings.stripDisfluencies && language.startsWith('en')) {
        rawTrimmed = stripFillerWords(rawTrimmed)
      }
      let trimmed = rawTrimmed

      // Command dictation (Ctrl+Shift+N with nothing highlighted): run the
      // transcript through the command's prompt — e.g. spoken rough notes
      // become a composed email. Fail-open to the raw transcript.
      const commandId = pendingCommandId
      pendingCommandId = null
      const command = commandId ? getCommand(commandId) : undefined
      if (command) {
        broadcast('transform-starting')
        try {
          const transformed = await transformText(command.prompt, rawTrimmed, command.model)
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

      // Smart-formatting pass: a second LLM call structures the flat Whisper
      // output into paragraphs / lists. Skipped for command dictations — the
      // command's LLM output is already structured. Fail-open: any error or
      // aborted call falls back to the raw text — the user must never lose
      // their dictation here.
      if (!command && liveSettings.enableSmartFormatting && shouldFormat(rawTrimmed)) {
        try {
          const formatted = await formatTranscript(rawTrimmed, {
            stripDisfluencies: liveSettings.stripDisfluencies,
          })
          if (mySession !== sessionId) {
            log.info('[recording] format result discarded — session invalidated')
            return
          }
          if (sanityCheck(rawTrimmed, formatted)) {
            trimmed = formatted
          } else {
            log.warn('[format] sanity check failed, using raw transcript')
          }
        } catch (err) {
          log.warn('[format] failed, falling back to raw', err)
        }
      }

      const targetSnapshot = focusTarget // captured before inject clears it

      // Inject FIRST so the paste isn't delayed by anything else.
      let injectResult
      try {
        injectResult = await injectText(trimmed, targetSnapshot)
      } catch (injectErr) {
        log.error('[recording] injection threw', injectErr)
        injectResult = { ok: false, method: 'clipboard' as const, error: 'inject-threw' }
      }
      if (mySession !== sessionId) {
        log.info('[recording] post-inject broadcast skipped — session invalidated')
        return
      }
      broadcast('transcription-complete', trimmed)
      if (!injectResult.ok) {
        broadcast('transcription-error', humanizeInjectError(injectResult.error ?? ''))
      }

      // Background sync to Supabase knowledge base (RAG index). Deferred to
      // setImmediate so the CPU-bound embedding step never delays paste —
      // by this point the user already saw their text appear.
      const token = getAuthToken()
      if (token) {
        setImmediate(() => {
          try {
            const payload = JSON.parse(
              Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
            )
            const userId = payload.sub
            if (userId) {
              // word_count reflects spoken words (raw), not list-marker overhead.
              syncToKnowledgeBase(trimmed, userId, {
                window_title: targetSnapshot?.title ?? null,
                app_name: targetSnapshot?.processName ?? null,
                word_count: rawTrimmed.split(/\s+/).filter(Boolean).length,
              }).catch((err) => log.error('[sync] knowledge-base sync failed', err))
            }
          } catch (e) {
            log.warn('[sync] failed to decode token for sync', e)
          }
        })
      }
    }
  } catch (err) {
    log.error('[recording] transcription failed', err)
    if (mySession === sessionId) {
      broadcast('transcription-error', humanizeTranscribeError(err as Error))
    }
  } finally {
    // Only mutate terminal state if we still own this session.
    if (mySession === sessionId) {
      broadcast('processing-complete')
      focusTarget = null
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
  void enqueue(async () => {
    broadcast('recording-stopped')
    broadcast('processing-complete')
    focusTarget = null
    pendingCommandId = null
    segments = []
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
  try {
    if (state === 'recording') {
      await Promise.race([
        stopRecorderSession().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
    }
  } finally {
    focusTarget = null
    pendingCommandId = null
    segments = []
    setState('idle')
  }
}
