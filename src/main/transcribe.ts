import { app } from 'electron'
import log from 'electron-log/main'
import { getAuthToken } from './ipc'
import { isProxyUrlAllowed } from './security'
import { getSettings } from './settings'
import { transcribeLocal, isLocalModelCached } from './local-whisper'
import { getWhisperPrompt, getPronunciationSpellings } from './user-context'
import { decodePcmViaRecorder } from './recorder'

const PRODUCTION_PROXY = 'https://speakflow-marketing.vercel.app/api'

/** Proxy base URL when this build should route through the Speakflow API.
 *  NOTE: keyed on app.isPackaged, NOT NODE_ENV — installed Electron apps
 *  never set NODE_ENV, which previously sent packaged builds down the
 *  direct-Groq path and demanded a local dev API key. */
export function getProxyBaseUrl(): string | undefined {
  return process.env.SPEAKFLOW_API_URL || (app.isPackaged ? PRODUCTION_PROXY : undefined)
}

// Keep the serverless proxy warm: an idle Vercel function adds a 1-3s
// cold-start to the FIRST dictation after a quiet period — the single
// biggest avoidable latency spike in the packaged app. A GET returns 405
// from inside the lambda, which is exactly enough to keep it hot.
//
// Each route is its OWN lambda on Vercel, so warming /transcribe does
// nothing for /dictate or /transform — all three are pinged every cycle.
// /dictate first (the primary Fast Batch path), the other two staggered a
// few seconds later so we never burst three TLS handshakes at once.
const KEEPALIVE_INTERVAL_MS = 4 * 60_000
const KEEPALIVE_STAGGER_MS = 2_500
let keepAliveTimer: NodeJS.Timeout | null = null

export function startProxyKeepAlive(): void {
  const base = getProxyBaseUrl()
  if (!base || keepAliveTimer) return
  const root = base.replace(/\/+$/, '')
  const ping = (route: string): void => {
    fetch(root + route, { method: 'GET' }).catch(() => undefined)
  }
  const cycle = (): void => {
    ping('/dictate')
    const t1 = setTimeout(() => ping('/transcribe'), KEEPALIVE_STAGGER_MS)
    t1.unref?.()
    const t2 = setTimeout(() => ping('/transform'), KEEPALIVE_STAGGER_MS * 2)
    t2.unref?.()
  }
  cycle()
  keepAliveTimer = setInterval(cycle, KEEPALIVE_INTERVAL_MS)
  // Don't let the keep-alive keep the process alive at quit.
  keepAliveTimer.unref?.()
  log.info('[transcribe] proxy keep-alive started (dictate + transcribe + transform)')
}

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
// Turbo is ~3x faster than whisper-large-v3 with marginal accuracy tradeoff —
// the right default for dictation latency. Override via SPEAKFLOW_WHISPER_MODEL
// to get the full model back.
const WHISPER_MODEL = process.env.SPEAKFLOW_WHISPER_MODEL || 'whisper-large-v3-turbo'
const MAX_BYTES = 25 * 1024 * 1024 // Groq hard limit
const REQUEST_TIMEOUT_MS = 60_000
const AUDIO_FILENAME = 'audio.webm'

// Deepgram Nova-3 — alternative cloud engine (better proper-noun accuracy,
// built-in smart formatting). Any Deepgram failure falls back to Groq.
// English sessions get language=en + keyterm biasing from trained
// pronunciations (keyterm prompting is nova-3 English-only); everything else
// keeps the multi autodetect with no keyterms.
function buildDeepgramListenUrl(language?: string): string {
  const url = new URL('https://api.deepgram.com/v1/listen')
  url.searchParams.set('model', 'nova-3')
  url.searchParams.set('smart_format', 'true')
  if (language && language.toLowerCase().startsWith('en')) {
    url.searchParams.set('language', 'en')
    for (const term of getPronunciationSpellings().slice(0, 20)) {
      if (term.length <= 40) url.searchParams.append('keyterm', term)
    }
  } else {
    url.searchParams.set('language', 'multi')
  }
  return url.toString()
}

interface TranscribeOptions {
  language?: string
  // 16 kHz mono PCM from the recorder — enables the on-device Whisper path.
  pcm?: Float32Array | null
  // Speech-seconds measured by the recorder's level monitor. Drives the
  // dictionary-prompt safety gate (see whisperPromptForClip). null/undefined
  // = no reading available → fail open.
  speechMs?: number | null
}

// ── Whisper prompt safety (hallucination guard, shared with dictate.ts) ────
// The personal-dictionary prompt biases Whisper toward the user's spellings —
// great on real dictations, ACTIVELY HARMFUL on marginal clips: on near-
// silent audio Whisper will happily "transcribe" the prompt words themselves.
// Only bias when the clip demonstrably contains sustained speech; otherwise
// fall back to the single-space prompt (non-empty, which suppresses the
// classic "Thanks for watching." silence hallucinations, but content-free).
export const DICTIONARY_PROMPT_MIN_SPEECH_MS = 1_500

export function whisperPromptForClip(speechMs: number | null | undefined): string {
  const allowDictionary = speechMs == null || speechMs >= DICTIONARY_PROMPT_MIN_SPEECH_MS
  return (allowDictionary ? getWhisperPrompt() : '') || ' '
}

export async function transcribeAudio(
  audio: Buffer,
  opts: TranscribeOptions = {},
): Promise<string> {
  if (audio.byteLength === 0) return ''

  const settings = getSettings()
  const mode = process.env.SPEAKFLOW_TRANSCRIPTION_MODE || settings.transcriptionMode
  const localModel =
    process.env.SPEAKFLOW_LOCAL_WHISPER_MODEL || settings.localWhisperModel

  if (mode === 'local' && opts.pcm && opts.pcm.length > 0) {
    const t0 = Date.now()
    try {
      const text = await transcribeLocal(opts.pcm, localModel, {
        language: opts.language,
      })
      log.info(`[timing] transcription path=local took ${Date.now() - t0}ms`)
      return text
    } catch (err) {
      log.warn('[transcribe] local whisper failed — falling back to cloud', err)
    }
  }

  const t0 = Date.now()
  try {
    const text = await transcribeViaCloud(audio, opts)
    log.info(`[timing] transcription path=cloud took ${Date.now() - t0}ms`)
    return text
  } catch (err) {
    // Offline resilience: if the cloud is unreachable and the local model is
    // already on disk, transcribe on-device instead of failing the dictation.
    const msg = (err as Error).message
    const networkFail = msg.includes('Could not reach') || msg.toLowerCase().includes('timeout')
    if (networkFail && isLocalModelCached(localModel)) {
      // Cloud sessions no longer ship PCM eagerly (needPcm gating in the
      // recorder), so this fallback usually has to ask the recorder window
      // to decode the blob on demand. Fail-open: a null decode just means we
      // surface the original network error instead of transcribing locally.
      let pcm = opts.pcm && opts.pcm.length > 0 ? opts.pcm : null
      if (!pcm) {
        pcm = await decodePcmViaRecorder(audio)
      }
      if (pcm && pcm.length > 0) {
        log.warn('[transcribe] cloud unreachable — falling back to local whisper')
        return transcribeLocal(pcm, localModel, { language: opts.language })
      }
      log.warn('[transcribe] cloud unreachable and no PCM available — cannot fall back to local')
    }
    throw err
  }
}

async function transcribeViaCloud(
  audio: Buffer,
  opts: TranscribeOptions,
): Promise<string> {
  if (audio.byteLength > MAX_BYTES) {
    throw new Error('Recording exceeds the 25 MB Groq limit. Try a shorter clip.')
  }

  const proxyUrl = getProxyBaseUrl()
  if (proxyUrl && !isProxyUrlAllowed(proxyUrl)) {
    throw new Error('Speakflow API URL is not allowed.')
  }

  // Env override wins over the setting — same pattern as
  // SPEAKFLOW_TRANSCRIPTION_MODE above.
  const provider =
    process.env.SPEAKFLOW_TRANSCRIPTION_PROVIDER || getSettings().transcriptionProvider

  if (provider === 'deepgram') {
    try {
      return proxyUrl
        ? await transcribeViaProxy(audio, proxyUrl, opts, 'deepgram')
        : await transcribeViaDeepgram(audio, opts.language)
    } catch (err) {
      // Deepgram is best-effort: missing key, non-200, or proxy
      // provider_unavailable all fall back to the Groq path transparently.
      log.warn('[transcribe] deepgram failed — falling back to groq', err)
    }
  }

  if (proxyUrl) {
    return transcribeViaProxy(audio, proxyUrl, opts)
  }

  return transcribeViaGroq(audio, opts)
}

// Exported: dictate.ts builds the /dictate multipart body on top of this.
export function buildAudioForm(buffer: Buffer, filename: string): FormData {
  const blob = new Blob([new Uint8Array(buffer)], { type: 'audio/webm' })
  const form = new FormData()
  form.append('file', blob, filename)
  return form
}

// Exported for dictate.ts — one timeout/abort implementation for all proxy calls.
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
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
  // When the user has a personal dictionary, their words become the prompt —
  // this biases Whisper toward their spellings (names, jargon, brands) — but
  // ONLY on clips with enough measured speech (see whisperPromptForClip).
  form.append('prompt', whisperPromptForClip(opts.speechMs))
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

async function transcribeViaDeepgram(buffer: Buffer, language?: string): Promise<string> {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) {
    throw new Error('DEEPGRAM_API_KEY is not set.')
  }

  let response: Response
  try {
    response = await fetchWithTimeout(
      buildDeepgramListenUrl(language),
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'audio/webm',
        },
        body: new Uint8Array(buffer),
      },
      REQUEST_TIMEOUT_MS,
    )
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Transcription timeout — please try again.')
    }
    throw new Error('Could not reach Deepgram.')
  }

  if (!response.ok) {
    const body = await safeReadBody(response)
    log.error(`[transcribe] Deepgram error ${response.status}`, body.slice(0, 500))
    throw new Error(`Deepgram returned ${response.status}`)
  }

  const data = (await response.json()) as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
  }
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
}

async function transcribeViaProxy(
  buffer: Buffer,
  baseUrl: string,
  opts: TranscribeOptions,
  provider?: 'deepgram',
): Promise<string> {
  const token = getAuthToken()
  if (!token) {
    throw new Error('Sign in via the dashboard to use Speakflow.')
  }

  const form = buildAudioForm(buffer, 'audio.webm')
  if (opts.language) form.append('language', opts.language)
  // Personal-dictionary spelling bias — the proxy forwards the prompt field
  // to Whisper. Always sent: on short/low-speech clips whisperPromptForClip
  // forces the single-space prompt instead of the dictionary (hallucination
  // guard), which is still better than no prompt at all.
  form.append('prompt', whisperPromptForClip(opts.speechMs))
  // Keyterm bias for the Deepgram proxy branch (v0.7.0, en-only server-side).
  // Old servers ignore the unknown field.
  if (provider === 'deepgram') {
    const keyterms = getPronunciationSpellings().slice(0, 20).join(',')
    if (keyterms) form.append('keyterms', keyterms.slice(0, 300))
  }

  const url =
    baseUrl.replace(/\/+$/, '') +
    '/transcribe' +
    (provider === 'deepgram' ? '?provider=deepgram' : '')
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

// Exported for dictate.ts.
export async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1024)
  } catch {
    return ''
  }
}

// Exported for dictate.ts — /dictate maps HTTP statuses to the exact same
// user-facing messages as /transcribe (incl. the 402 quota wording).
export function userMessageForStatus(status: number): string {
  if (status === 401) return 'Authentication failed. Sign in again.'
  if (status === 402) return 'Weekly free limit reached — upgrade to Pro in your Speakflow dashboard'
  if (status === 403) return 'Your plan limit was reached. Upgrade to continue.'
  if (status === 413) return 'Audio too long. Record a shorter clip.'
  if (status === 429) return 'Rate limit hit. Try again in a moment.'
  if (status >= 500) return 'Transcription service is temporarily unavailable.'
  return 'Transcription failed. Try again.'
}
