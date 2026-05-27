import log from 'electron-log/main'
import { getAuthToken } from './ipc'
import { isProxyUrlAllowed } from './security'

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
// Turbo is ~3x faster than whisper-large-v3 with marginal accuracy tradeoff.
// Override via SPEAKFLOW_WHISPER_MODEL if you want the full model.
const WHISPER_MODEL = process.env.SPEAKFLOW_WHISPER_MODEL || 'whisper-large-v3-turbo'
const MAX_BYTES = 25 * 1024 * 1024 // Groq hard limit
const REQUEST_TIMEOUT_MS = 60_000
const AUDIO_FILENAME = 'audio.webm'

interface TranscribeOptions {
  language?: string
}

export async function transcribeAudio(
  audio: Buffer,
  opts: TranscribeOptions = {},
): Promise<string> {
  if (audio.byteLength === 0) return ''
  if (audio.byteLength > MAX_BYTES) {
    throw new Error('Recording exceeds the 25 MB Groq limit. Try a shorter clip.')
  }

  const PRODUCTION_PROXY = 'https://speakflow-marketing.vercel.app/api'
  const proxyUrl = process.env.SPEAKFLOW_API_URL ||
    (process.env.NODE_ENV === 'production' ? PRODUCTION_PROXY : undefined)
  if (proxyUrl) {
    if (!isProxyUrlAllowed(proxyUrl)) {
      throw new Error('Speakflow API URL is not allowed.')
    }
    return transcribeViaProxy(audio, proxyUrl, opts)
  }

  return transcribeViaGroq(audio, opts)
}

function buildAudioForm(buffer: Buffer, filename: string): FormData {
  const blob = new Blob([new Uint8Array(buffer)], { type: 'audio/webm' })
  const form = new FormData()
  form.append('file', blob, filename)
  return form
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function transcribeViaGroq(
  buffer: Buffer,
  opts: TranscribeOptions,
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set. Add it to .env for local development.')
  }

  const form = buildAudioForm(buffer, AUDIO_FILENAME)
  form.append('model', WHISPER_MODEL)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  // A non-empty prompt suppresses Whisper's "Thank you." / "Thanks for watching."
  // hallucinations that occur when it receives silent or low-energy audio.
  form.append('prompt', ' ')
  if (opts.language) form.append('language', opts.language)

  let response: Response
  try {
    response = await fetchWithTimeout(
      GROQ_TRANSCRIPTIONS_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
      REQUEST_TIMEOUT_MS,
    )
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Transcription timeout — please try again.')
    }
    throw new Error('Could not reach Groq. Check your internet connection.')
  }

  if (!response.ok) {
    const body = await safeReadBody(response)
    log.error(`[transcribe] Groq error ${response.status}`, body.slice(0, 500))
    throw new Error(userMessageForStatus(response.status))
  }

  const data = (await response.json()) as { text?: string }
  return data.text ?? ''
}

async function transcribeViaProxy(
  buffer: Buffer,
  baseUrl: string,
  opts: TranscribeOptions,
): Promise<string> {
  const token = getAuthToken()
  if (!token) {
    throw new Error('Sign in via the dashboard to use Speakflow.')
  }

  const form = buildAudioForm(buffer, 'audio.webm')
  if (opts.language) form.append('language', opts.language)

  const url = baseUrl.replace(/\/+$/, '') + '/transcribe'
  let response: Response
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      },
      REQUEST_TIMEOUT_MS,
    )
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Transcription timeout — please try again.')
    }
    throw new Error('Could not reach the Speakflow API.')
  }

  if (!response.ok) {
    const body = await safeReadBody(response)
    log.error(`[transcribe] proxy error ${response.status}`, body.slice(0, 500))
    throw new Error(userMessageForStatus(response.status))
  }

  const data = (await response.json()) as { text?: string; error?: string }
  if (data.error) {
    log.warn(`[transcribe] proxy returned error: ${data.error}`)
    throw new Error('Transcription failed. Try again.')
  }
  return data.text ?? ''
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1024)
  } catch {
    return ''
  }
}

function userMessageForStatus(status: number): string {
  if (status === 401) return 'Authentication failed. Sign in again.'
  if (status === 403) return 'Your plan limit was reached. Upgrade to continue.'
  if (status === 413) return 'Audio too long. Record a shorter clip.'
  if (status === 429) return 'Rate limit hit. Try again in a moment.'
  if (status >= 500) return 'Transcription service is temporarily unavailable.'
  return 'Transcription failed. Try again.'
}
