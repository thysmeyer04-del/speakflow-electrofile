import fs from 'fs/promises'
import path from 'path'
import log from 'electron-log/main'
import { getAuthToken } from './ipc'
import { isProxyUrlAllowed } from './security'

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const WHISPER_MODEL = 'whisper-large-v3'
const MAX_BYTES = 25 * 1024 * 1024 // Groq hard limit
const REQUEST_TIMEOUT_MS = 60_000

interface TranscribeOptions {
  language?: string
}

export async function transcribeAudio(
  audioFilePath: string,
  opts: TranscribeOptions = {},
): Promise<string> {
  const buffer = await readAudioCapped(audioFilePath)
  if (buffer.byteLength === 0) return ''

  const proxyUrl = process.env.SPEAKFLOW_API_URL
  if (proxyUrl && process.env.NODE_ENV === 'production') {
    if (!isProxyUrlAllowed(proxyUrl)) {
      throw new Error('Speakflow API URL is not allowed.')
    }
    return transcribeViaProxy(buffer, proxyUrl, opts)
  }

  return transcribeViaGroq(buffer, opts, audioFilePath)
}

/**
 * Read the file with a hard cap. Validates size AFTER read to avoid TOCTOU
 * between fs.stat() and fs.readFile().
 */
async function readAudioCapped(audioFilePath: string): Promise<Buffer> {
  // Pre-check via stat for fast failure on huge files.
  const stat = await fs.stat(audioFilePath)
  if (stat.size > MAX_BYTES) {
    throw new Error('Recording exceeds the 25 MB Groq limit. Try a shorter clip.')
  }
  if (stat.size === 0) return Buffer.alloc(0)

  const buf = await fs.readFile(audioFilePath)
  if (buf.byteLength > MAX_BYTES) {
    throw new Error('Recording exceeds the 25 MB Groq limit. Try a shorter clip.')
  }
  return buf
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
  audioFilePath: string,
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set. Add it to .env for local development.')
  }

  const form = buildAudioForm(buffer, path.basename(audioFilePath))
  form.append('model', WHISPER_MODEL)
  form.append('response_format', 'json')
  form.append('temperature', '0')
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
