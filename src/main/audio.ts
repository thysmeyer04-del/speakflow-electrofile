import { BrowserWindow, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import log from 'electron-log/main'
import { startRecording as startRecorder, stopRecording as stopRecorder } from './recorder'
import { transcribeAudio } from './transcribe'
import { injectText } from './inject'
import { getSettings } from './settings'

let state: 'idle' | 'recording' | 'processing' = 'idle'
let stateListeners: Array<(s: typeof state) => void> = []

function broadcast(channel: string, payload?: unknown) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

function setState(next: typeof state) {
  state = next
  for (const cb of stateListeners) cb(next)
}

export function onStateChange(cb: (s: typeof state) => void): () => void {
  stateListeners.push(cb)
  return () => {
    stateListeners = stateListeners.filter((l) => l !== cb)
  }
}

export function getState(): typeof state {
  return state
}

export function isRecording(): boolean {
  return state === 'recording'
}

export async function toggleRecording(): Promise<void> {
  if (state === 'idle') {
    await startRecording()
  } else if (state === 'recording') {
    await stopRecording()
  }
  // ignore toggle while processing — feedback to user via overlay
}

export async function startRecording(): Promise<void> {
  if (state !== 'idle') return
  const settings = getSettings()
  try {
    await startRecorder({ microphoneId: settings.microphone })
    setState('recording')
    broadcast('recording-started')
    if (settings.dictationSounds) playSound('start')
  } catch (err) {
    log.error('Failed to start recording', err)
    broadcast('transcription-error', (err as Error).message)
  }
}

export async function stopRecording(): Promise<void> {
  if (state !== 'recording') return
  setState('processing')
  broadcast('recording-stopped')
  broadcast('processing-started')

  const settings = getSettings()
  if (settings.dictationSounds) playSound('stop')

  let audioBuffer: Buffer | null = null
  try {
    audioBuffer = await stopRecorder()
  } catch (err) {
    log.error('Recorder stop failed', err)
    broadcast('transcription-error', (err as Error).message)
    broadcast('processing-complete')
    setState('idle')
    return
  }

  if (!audioBuffer || audioBuffer.byteLength === 0) {
    broadcast('processing-complete')
    setState('idle')
    return
  }

  let tempFile: string | null = null
  try {
    tempFile = path.join(app.getPath('temp'), `speakflow_${Date.now()}.webm`)
    await fs.writeFile(tempFile, audioBuffer)

    const language = settings.language === 'auto' ? undefined : settings.language
    const text = await transcribeAudio(tempFile, { language })

    if (text && text.trim()) {
      await injectText(text.trim())
      broadcast('transcription-complete', text.trim())
    }
  } catch (err) {
    log.error('Transcription pipeline failed', err)
    broadcast('transcription-error', (err as Error).message)
  } finally {
    if (tempFile) {
      fs.unlink(tempFile).catch(() => undefined)
    }
    broadcast('processing-complete')
    setState('idle')
  }
}

function playSound(kind: 'start' | 'stop'): void {
  const file = path.join(__dirname, '..', '..', 'assets', 'sounds', `${kind}.mp3`)
  const { exec } = require('child_process') as typeof import('child_process')
  if (process.platform === 'darwin') {
    exec(`afplay "${file}"`, () => undefined)
  } else if (process.platform === 'win32') {
    // Use PowerShell Media.SoundPlayer for WAV. For MP3 fall back to start command.
    exec(`powershell -NoProfile -Command "(New-Object Media.SoundPlayer '${file}').PlaySync()"`, () => undefined)
  } else {
    exec(`paplay "${file}" || aplay "${file}"`, () => undefined)
  }
}
