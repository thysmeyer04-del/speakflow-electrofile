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
} from './recorder'
import { transcribeAudio } from './transcribe'
import { injectText, captureFocusTarget, WindowSnapshot } from './inject'
import { getSettings } from './settings'
import { playSound } from './sound'
import fs from 'fs/promises'
import path from 'path'
import { app } from 'electron'

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

// Crash recovery: if the recorder window dies mid-recording, force-idle and
// surface an error.
onRecorderCrash((reason) => {
  if (state === 'idle') return
  log.error(`[recording] recorder crash: ${reason}`)
  broadcast('transcription-error', 'Recorder crashed — please try again.')
  broadcast('processing-complete')
  setState('idle')
})

// VAD / 60s-cap initiated stop: the recorder has buffered the blob and is
// waiting for main to ask for it. Drive a normal stop through the queue.
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
  setState('starting')
  const settings = getSettings()

  // Capture the focus target BEFORE we start the recorder window (which
  // could itself momentarily affect z-order on some platforms). This is
  // the window we'll paste into after transcription completes.
  focusTarget = await captureFocusTarget()

  // Note: startRecorderSession lazy-inits the recorder window if it isn't
  // already up, so we don't reject on isRecorderHealthy() === false here.
  try {
    await startRecorderSession({ microphoneId: settings.microphone })
  } catch (err) {
    const msg = (err as Error).message
    log.error('[recording] start failed', err)
    broadcast('transcription-error', humanizeStartError(msg))
    setState('idle')
    return
  }

  setState('recording')
  broadcast('recording-started')
  if (settings.dictationSounds) playSound('start')
}

async function doStop(): Promise<void> {
  setState('stopping')
  broadcast('recording-stopped')

  const settings = getSettings()
  if (settings.dictationSounds) playSound('stop')

  let audioBuffer: Buffer | null = null
  try {
    audioBuffer = await stopRecorderSession()
  } catch (err) {
    log.error('[recording] stop failed', err)
    broadcast('transcription-error', 'Could not finalise the recording.')
    broadcast('processing-complete')
    setState('idle')
    return
  }

  setState('processing')
  broadcast('processing-started')

  if (!audioBuffer || audioBuffer.byteLength === 0) {
    broadcast('processing-complete')
    setState('idle')
    return
  }

  await processAudio(audioBuffer, settings.language)
}

async function processAudio(buffer: Buffer, language: string): Promise<void> {
  let tempFile: string | null = null
  try {
    tempFile = path.join(app.getPath('temp'), `speakflow_${Date.now()}.webm`)
    await fs.writeFile(tempFile, buffer)

    const lang = language === 'auto' ? undefined : language
    const text = await transcribeAudio(tempFile, { language: lang })

    if (text && text.trim()) {
      const trimmed = text.trim()
      let injectResult
      try {
        injectResult = await injectText(trimmed, focusTarget)
      } catch (injectErr) {
        log.error('[recording] injection threw', injectErr)
        injectResult = { ok: false, method: 'clipboard' as const, error: 'inject-threw' }
      }
      broadcast('transcription-complete', trimmed)
      if (!injectResult.ok) {
        broadcast('transcription-error', humanizeInjectError(injectResult.error ?? ''))
      }
    }
  } catch (err) {
    log.error('[recording] transcription failed', err)
    broadcast('transcription-error', humanizeTranscribeError(err as Error))
  } finally {
    if (tempFile) {
      fs.unlink(tempFile).catch(() => undefined)
    }
    broadcast('processing-complete')
    setState('idle')
  }
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
  if (reason === 'focus-lost' || reason === 'no-target-snapshot') {
    return 'Text copied to clipboard — focus changed, click back into your editor and press Ctrl+V.'
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
  try {
    if (state === 'recording') {
      await Promise.race([
        stopRecorderSession().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
    }
  } finally {
    setState('idle')
  }
}
