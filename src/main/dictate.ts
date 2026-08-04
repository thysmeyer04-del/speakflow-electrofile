// Single round-trip dictation client for POST /api/dictate ("Fast Batch").
//
// The legacy pipeline paid two full proxy round-trips per dictation:
// /transcribe (blob → Whisper) and then /transform (raw text → formatting
// LLM), with the client re-uploading state in between. /dictate collapses
// both into ONE request: the server transcribes, runs its hallucination
// filter, and formats — returning raw + formatted together with per-stage
// timings. Measured impact: the two-RTT chain averaged ~4.4 s of network +
// server time; one RTT removes an entire client↔Vercel↔Groq leg.
//
// Contract (FROZEN, coordinated with the server team — code against this,
// not their repo):
//   POST ${proxyBase}/dictate  multipart, Bearer <Supabase JWT>
//   fields: file (webm blob), language?, prompt? (≤300), format '1'|'0',
//           stripDisfluencies '1'|'0', appName? (≤120), windowTitle? (≤200),
//           dictionary? (comma list ≤300),
//           formatModel? ('llama-3.1-8b-instant' default |
//                         'llama-3.3-70b-versatile'),
//           speechMs? (client-measured ms of actual speech; the server skips
//                      its anti-hallucination phrase blocklist when
//                      speechMs ≥ 1500 — a trusted clip's legitimate short
//                      "Thank you!" must not be eaten — and applies it when
//                      the field is absent or short)
//   200 → { text (raw), formatted?, skippedFormat?, droppedSegments?,
//           timings: { authMs, quotaMs, bodyMs, groqMs, formatMs, totalMs } }
//   errors: 401 {error} · 402 {error:'word_limit_reached',used,limit} ·
//           413 · 500 · 503. Formatting failure is NEVER a hard failure —
//           the server returns 200 with skippedFormat + formatError.
//
// Error split for the caller (recording-controller):
//   - 401/402 carry `dictateStatus` and must SURFACE to the user (retrying
//     the legacy path would fail identically and waste a second upload);
//   - everything else (offline, DNS, 404 while the route is still deploying,
//     5xx, 503, timeout) is fallback-eligible → transparent legacy retry.

import log from 'electron-log/main'
import { getAuthToken } from './ipc'
import { isProxyUrlAllowed } from './security'
import {
  getProxyBaseUrl,
  buildAudioForm,
  fetchWithTimeout,
  safeReadBody,
  userMessageForStatus,
  whisperPromptForClip,
} from './transcribe'

const REQUEST_TIMEOUT_MS = 60_000
const MAX_BYTES = 25 * 1024 * 1024 // Groq hard limit — same gate as /transcribe
// Contract field ceilings — the server hard-rejects oversized fields, and a
// rejected dictation is worse than a truncated window title.
const MAX_APP_NAME_CHARS = 120
const MAX_WINDOW_TITLE_CHARS = 200
const MAX_DICTIONARY_CHARS = 300
const MAX_DICTIONARY_WORDS = 25

export interface DictateServerTimings {
  authMs?: number
  quotaMs?: number
  bodyMs?: number
  groqMs?: number
  formatMs?: number
  totalMs?: number
}

export interface DictateOptions {
  language?: string
  format: boolean
  stripDisfluencies: boolean
  appName?: string | null
  windowTitle?: string | null
  dictionary: string[]
  // Speech-seconds from the recorder's level monitor — gates the dictionary
  // bias prompt exactly like the legacy path (see whisperPromptForClip).
  speechMs: number | null
}

export interface DictateResult {
  raw: string
  formatted?: string
  // True when the server did not produce usable formatted text (its own
  // shouldFormat skip, a formatting failure, or format was never requested).
  // The caller then applies the local cheap cleanup (stripFillerWords) only.
  skipped: boolean
  serverTimings?: DictateServerTimings
}

// Attached to thrown errors so the caller can split "surface to user" from
// "transparent legacy fallback" without string-matching messages.
interface DictateHttpError extends Error {
  dictateStatus?: number
}

/** 401 (auth) / 402 (quota): retrying via the legacy path would fail the
 *  same way — these must surface to the user exactly as they do today. */
export function isAuthOrQuotaError(err: unknown): boolean {
  const status = (err as DictateHttpError | null)?.dictateStatus
  return status === 401 || status === 402
}

/** One-round-trip dictation via the Speakflow proxy. Proxy-only by design:
 *  dev builds without a proxy keep the legacy direct-Groq path. */
export async function dictateViaProxy(
  audio: Buffer,
  opts: DictateOptions,
): Promise<DictateResult> {
  if (audio.byteLength > MAX_BYTES) {
    throw new Error('Recording exceeds the 25 MB Groq limit. Try a shorter clip.')
  }

  const baseUrl = getProxyBaseUrl()
  if (!baseUrl) {
    throw new Error('Speakflow API is not configured.')
  }
  if (!isProxyUrlAllowed(baseUrl)) {
    throw new Error('Speakflow API URL is not allowed.')
  }
  const token = getAuthToken()
  if (!token) {
    // Same wording as the legacy proxy path — humanizeTranscribeError keys
    // on "Sign in". NOTE: no dictateStatus here on purpose; a missing local
    // token is not a server 401, but the legacy path would throw the exact
    // same error, so falling back would only add latency. The controller
    // treats it as fallback-eligible and the legacy path re-throws it — the
    // user sees the same message either way.
    throw new Error('Sign in via the dashboard to use Speakflow.')
  }

  const form = buildAudioForm(audio, 'audio.webm')
  if (opts.language) form.append('language', opts.language)
  // Whisper bias prompt with the same speech-seconds safety gate as the
  // legacy path: dictionary words only on clips with real sustained speech,
  // single space otherwise. (≤200 chars from user-context — inside the
  // contract's 300-char ceiling.)
  form.append('prompt', whisperPromptForClip(opts.speechMs))
  form.append('format', opts.format ? '1' : '0')
  form.append('stripDisfluencies', opts.stripDisfluencies ? '1' : '0')
  if (opts.appName) form.append('appName', opts.appName.slice(0, MAX_APP_NAME_CHARS))
  if (opts.windowTitle) {
    form.append('windowTitle', opts.windowTitle.slice(0, MAX_WINDOW_TITLE_CHARS))
  }
  const dictionary = buildDictateDictionaryField(opts.dictionary)
  if (dictionary) form.append('dictionary', dictionary)
  // Client-measured speech seconds → server-side blocklist gating: with
  // speechMs ≥ 1500 the server trusts the clip and skips its silence-artifact
  // blocklist. Omitted when the level monitor produced no usable reading —
  // absence tells the server to keep the blocklist active, the safe default.
  // Finiteness is checked, not just null: an undefined or NaN reading used to
  // be sent as the literal string "NaN", which the server cannot interpret.
  if (typeof opts.speechMs === 'number' && Number.isFinite(opts.speechMs)) {
    form.append('speechMs', String(Math.round(opts.speechMs)))
  }
  // formatModel is normally OMITTED — the server default (8b-instant) is the
  // Fast Batch choice. SPEAKFLOW_FORMAT_MODEL is the shared dev knob: it
  // already overrides the local formatter (format-transcript.ts), so pass it
  // through here too and the override applies on whichever path runs.
  if (process.env.SPEAKFLOW_FORMAT_MODEL) {
    form.append('formatModel', process.env.SPEAKFLOW_FORMAT_MODEL)
  }

  const url = baseUrl.replace(/\/+$/, '') + '/dictate'
  const t0 = Date.now()
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
    log.error(`[dictate] proxy error ${response.status}`, body.slice(0, 500))
    const httpErr = new Error(userMessageForStatus(response.status)) as DictateHttpError
    httpErr.dictateStatus = response.status
    throw httpErr
  }

  let data: {
    text?: string
    formatted?: string
    skippedFormat?: boolean
    formatError?: string
    droppedSegments?: number
    timings?: DictateServerTimings
    error?: string
  }
  try {
    data = (await response.json()) as typeof data
  } catch {
    throw new Error('Transcription failed. Try again.')
  }
  if (data.error) {
    log.warn(`[dictate] proxy returned error: ${data.error}`)
    throw new Error('Transcription failed. Try again.')
  }

  const clientRtt = Date.now() - t0
  const st = data.timings
  if (st) {
    // Server-vs-network split: everything the server can't see (TLS, upload,
    // download, Vercel routing) is clientRtt - serverTotal.
    const serverTotal = typeof st.totalMs === 'number' ? st.totalMs : 0
    log.info(
      `[timing] dictate server auth=${st.authMs ?? '?'} quota=${st.quotaMs ?? '?'} body=${st.bodyMs ?? '?'} ` +
        `groq=${st.groqMs ?? '?'} format=${st.formatMs ?? '?'} total=${st.totalMs ?? '?'}; ` +
        `clientRtt=${clientRtt}; network=${clientRtt - serverTotal}`,
    )
  } else {
    log.info(`[timing] dictate clientRtt=${clientRtt} (no server timings in response)`)
  }
  if (typeof data.droppedSegments === 'number' && data.droppedSegments > 0) {
    log.info(`[dictate] server hallucination filter dropped ${data.droppedSegments} segment(s)`)
  }
  if (data.skippedFormat && data.formatError) {
    log.warn(`[dictate] server skipped formatting: ${data.formatError}`)
  }

  const raw = data.text ?? ''
  const formatted =
    typeof data.formatted === 'string' && data.formatted.trim().length > 0
      ? data.formatted
      : undefined
  return {
    raw,
    formatted,
    skipped: data.skippedFormat === true || !formatted,
    serverTimings: st,
  }
}

/** Contract dictionary field: up to 25 words, comma-joined, hard-capped at
 *  300 chars WITHOUT cutting a word in half. Note the prompt field and this
 *  field draw from the SAME user dictionary (via the caller passing
 *  getDictionaryWords()) but have different budgets and different safety
 *  gates — the prompt biases Whisper decoding (dangerous on a silent clip,
 *  hence the presence-of-speech gate), the dictionary feeds the server's
 *  formatter (spelling correction only, safe to always send).
 *  Exported for the provider-payload size tests. */
export function buildDictateDictionaryField(words: string[]): string {
  let out = ''
  for (const word of words.slice(0, MAX_DICTIONARY_WORDS)) {
    const trimmed = word.trim()
    if (!trimmed) continue
    const next = out ? `${out},${trimmed}` : trimmed
    if (next.length > MAX_DICTIONARY_CHARS) break
    out = next
  }
  return out
}
