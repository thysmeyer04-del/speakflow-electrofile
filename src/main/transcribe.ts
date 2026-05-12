import fs from 'fs/promises'
import path from 'path'
import log from 'electron-log/main'
import { getAuthToken } from './ipc'

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const WHISPER_MODEL = 'whisper-large-v3'
const MAX_BYTES = 25 * 1024 * 1024 // Groq hard limit

interface TranscribeOptions {
  language?: string
}

export async function transcribeAudio(
  audioFilePath: string,
  opts: TranscribeOptions = {},
): Promise<string> {
  const stat = await fs.stat(audioFilePath)
  if (stat.size === 0) return ''
  if (stat.size > MAX_BYTES) {
    throw new Error('Recording exceeds the 25 MB Groq limit. Try a shorter clip.')
  }

  const proxyUrl = process.env.SPEAKFLOW_API_URL
  if (proxyUrl && process.env.NODE_ENV === 'production') {
    return transcribeViaProxy(audioFilePath, proxyUrl, opts)
  }

  return transcribeViaGroq(audioFilePath, opts)
}

async function buildAudioForm(audioFilePath: string): Promise<FormData> {
  const buffer = await fs.readFile(audioFilePath)
  const blob = new Blob([new Uint8Array(buffer)], { type: 'audio/webm' })
  const form = new FormData()
  form.append('file', blob, path.basename(audioFilePath))
  return form
}

async function transcribeViaGroq(
  audioFilePath: string,
  opts: TranscribeOptions,
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error(
      'GROQ_API_KEY is not set. Add it to .env for local development.',
    )
  }

  const form = await buildAudioForm(audioFilePath)
  form.append('model', WHISPER_MODEL)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (opts.language) form.append('language', opts.language)

  const response = await fetch(GROQ_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  if (!response.ok) {
    const body = await response.text()
    log.error(`Groq error ${response.status}: ${body}`)
    if (response.status === 401)
      throw new Error('Groq rejected the API key (401). Check GROQ_API_KEY.')
    if (response.status === 413)
      throw new Error('Audio too large for Groq (413). Record a shorter clip.')
    if (response.status === 429)
      throw new Error('Groq rate limit hit (429). Try again in a moment.')
    throw new Error(`Groq error ${response.status}: ${body.slice(0, 200)}`)
  }

  const data = (await response.json()) as { text?: string }
  return data.text ?? ''
}

async function transcribeViaProxy(
  audioFilePath: string,
  baseUrl: string,
  opts: TranscribeOptions,
): Promise<string> {
  const token = getAuthToken()
  if (!token) {
    throw new Error('Sign in via the dashboard to use Speakflow.')
  }

  const form = await buildAudioForm(audioFilePath)
  if (opts.language) form.append('language', opts.language)

  const url = baseUrl.replace(/\/+$/, '') + '/transcribe'
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })

  if (!response.ok) {
    const body = await response.text()
    log.error(`Proxy transcribe error ${response.status}: ${body}`)
    throw new Error(`Speakflow API error ${response.status}: ${body.slice(0, 200)}`)
  }

  const data = (await response.json()) as { text?: string; error?: string }
  if (data.error) throw new Error(data.error)
  return data.text ?? ''
}
