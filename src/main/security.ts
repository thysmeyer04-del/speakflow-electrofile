// Shared security helpers for the main process.

import { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { randomBytes, timingSafeEqual } from 'crypto'

let allowedSenderId: number | null = null
let allowedOrigin: string | null = null
let trustedMainFrameNonce: string | null = null

export function configureSecurity(opts: {
  allowedSenderId: number
  allowedOrigin: string
}): void {
  allowedSenderId = opts.allowedSenderId
  trustedMainFrameNonce = randomBytes(32).toString('hex')
  try {
    allowedOrigin = new URL(opts.allowedOrigin).origin
  } catch {
    allowedOrigin = opts.allowedOrigin
  }
}

/** Hard gate for ipcMain.on / ipcMain.handle. */
export function assertTrustedSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
  nonce?: unknown,
): boolean {
  if (allowedSenderId === null) {
    log.warn(`[security] IPC "${channel}" rejected — security not yet configured`)
    return false
  }
  if (event.sender.id !== allowedSenderId) {
    log.warn(
      `[security] IPC "${channel}" from sender ${event.sender.id} rejected (expected ${allowedSenderId})`,
    )
    return false
  }
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    log.warn(`[security] IPC "${channel}" rejected — sender is not the trusted main frame`)
    return false
  }
  const frameUrl = event.senderFrame?.url ?? ''
  if (frameUrl) {
    try {
      const origin = new URL(frameUrl).origin
      if (origin !== allowedOrigin) {
        log.warn(
          `[security] IPC "${channel}" from origin ${origin} rejected (expected ${allowedOrigin})`,
        )
        return false
      }
    } catch {
      log.warn(`[security] IPC "${channel}" from unparseable url ${frameUrl}`)
      return false
    }
  }
  if (typeof nonce !== 'string' || !trustedMainFrameNonce) {
    log.warn(`[security] IPC "${channel}" rejected — missing frame nonce`)
    return false
  }
  const supplied = Buffer.from(nonce, 'utf8')
  const expected = Buffer.from(trustedMainFrameNonce, 'utf8')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    log.warn(`[security] IPC "${channel}" rejected — invalid frame nonce`)
    return false
  }
  return true
}

/** Bootstrap the per-process nonce only to the configured trusted main frame. */
export function issueTrustedFrameNonce(
  event: IpcMainInvokeEvent,
  channel = 'security:get-nonce',
): string | null {
  if (allowedSenderId === null || event.sender.id !== allowedSenderId) return null
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return null
  if (!isOriginTrusted(event.senderFrame.url)) {
    log.warn(`[security] IPC "${channel}" rejected — untrusted nonce request`)
    return null
  }
  return trustedMainFrameNonce
}

export function isOriginTrusted(url: string): boolean {
  if (!allowedOrigin) return false
  try {
    return new URL(url).origin === allowedOrigin
  } catch {
    return false
  }
}

// ── External-link allowlist for shell.openExternal ─────────────────────────
// Hard-coded list of public hosts the app is allowed to open in the OS browser.
// Anything else is rejected.
const EXTERNAL_HOST_ALLOWLIST = new Set<string>([
  'speakflow.app',
  'app.speakflow.app',
  'www.speakflow.app',
  'docs.speakflow.app',
  'help.speakflow.app',
  'github.com',
  'stripe.com',
  'billing.stripe.com',
])

export function isExternalUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    if (EXTERNAL_HOST_ALLOWLIST.has(host)) return true
    // Allow subdomains of speakflow.app
    if (host.endsWith('.speakflow.app')) return true
    return false
  } catch {
    return false
  }
}

// ── Renderer-supplied input validators (defence in depth — preload already
//    enforces these, but main MUST not trust the preload). ─────────────────
const HOTKEY_PATTERN =
  /^((Control|Ctrl|Alt|Option|Shift|Cmd|Command|Meta|Super)\+){0,3}(F\d{1,2}|[A-Z0-9]|Space|Tab|Backspace|Delete|Return|Enter|Escape|Up|Down|Left|Right|Home|End|PageUp|PageDown)$/i

const ALLOWED_LANGUAGES = new Set([
  'auto', 'en', 'af', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru',
  'ja', 'ko', 'zh', 'ar', 'hi', 'tr', 'sv', 'da', 'no', 'fi',
])

export function validateHotkey(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed.length > 64) return null
  if (!HOTKEY_PATTERN.test(trimmed)) return null
  return trimmed
}

export function validateMicrophoneId(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed.length > 256) return null
  // deviceId from getUserMedia is a non-whitespace hex/base64-ish string
  if (!/^[A-Za-z0-9+/=._-]+$/.test(trimmed) && trimmed !== 'default') return null
  return trimmed
}

export function validateLanguage(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const lower = input.trim().toLowerCase()
  if (!ALLOWED_LANGUAGES.has(lower)) return null
  return lower
}

export type ToggleKey =
  | 'showOverlay'
  | 'overlayHandleVisible'
  | 'dictationSounds'
  | 'launchAtLogin'
  | 'enableSmartFormatting'
  | 'stripDisfluencies'
  // True Streaming diagnostics: after a stream-path dictation, re-run the
  // batch engine on the same blob in the background and log a diff ratio.
  | 'asrShadowCompare'
  | 'flowcastEnabled'
  | 'flowcastCaptureMic'
  | 'flowcastCaptureSystemAudio'
  | 'flowcastCursor'
  // Legacy: the streamingTranscription setting was removed along with
  // segment-on-pause streaming (Fast Batch, 2026-07), but old DEPLOYED
  // dashboards still render the toggle and send this key over IPC. It stays
  // in the allowlist so those dashboards get { ok: true } instead of an
  // error banner; ipc.ts treats it as an accepted no-op (nothing is stored).
  | 'streamingTranscription'

export function validateToggleKey(input: unknown): ToggleKey | null {
  if (typeof input !== 'string') return null
  const allowed = new Set<ToggleKey>([
    'showOverlay',
    'overlayHandleVisible',
    'dictationSounds',
    'launchAtLogin',
    'enableSmartFormatting',
    'stripDisfluencies',
    'asrShadowCompare',
    'flowcastEnabled',
    'flowcastCaptureMic',
    'flowcastCaptureSystemAudio',
    'flowcastCursor',
    'streamingTranscription', // accepted-but-ignored — see ToggleKey note
  ])
  return (allowed as Set<string>).has(input) ? (input as ToggleKey) : null
}

// ── Choice settings (string enums the dashboard may set over IPC) ──────────
// Strict allowlist of key → permitted values. Anything else is rejected —
// never write a renderer-supplied string into electron-store unvalidated.
export type ChoiceSetting =
  | { key: 'transcriptionMode'; value: 'cloud' | 'local' }
  | { key: 'transcriptionProvider'; value: 'groq' | 'deepgram' }
  | { key: 'streamingEngine'; value: 'off' | 'deepgram' }
  | { key: 'flowcastQuality'; value: 'balanced' | 'high' }
  | { key: 'flowcastVisibility'; value: 'private' | 'unlisted' }
  | { key: 'flowcastStorageMode'; value: 'onedrive' | 'cloud' }

const CHOICE_SETTINGS: Record<string, ReadonlySet<string>> = {
  transcriptionMode: new Set(['cloud', 'local']),
  transcriptionProvider: new Set(['groq', 'deepgram']),
  // Deepgram live transcription; failures retain the recorded batch path.
  streamingEngine: new Set(['off', 'deepgram']),
  flowcastQuality: new Set(['balanced', 'high']),
  flowcastVisibility: new Set(['private', 'unlisted']),
  flowcastStorageMode: new Set(['onedrive', 'cloud']),
}

export function validateChoiceSetting(
  key: unknown,
  value: unknown,
): ChoiceSetting | null {
  if (typeof key !== 'string' || typeof value !== 'string') return null
  const allowed = CHOICE_SETTINGS[key]
  if (!allowed || !allowed.has(value)) return null
  return { key, value } as ChoiceSetting
}

// ── JWT validation (decode-only — signature verification happens server-side) ──
interface JwtHeader {
  alg?: string
  typ?: string
}
interface JwtPayload {
  exp?: number
  iat?: number
  nbf?: number
  sub?: string
  aud?: string | string[]
  iss?: string
}

const MAX_JWT_LENGTH = 4096
const CLOCK_SKEW_SECONDS = 30
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 3600

// Supabase JWTs always have issuer https://<project-ref>.supabase.co/auth/v1
const SUPABASE_ISSUER_PATTERN = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/auth\/v1$/

export interface JwtValidationResult {
  ok: boolean
  expiresAt: number | null
  subject?: string
  reason?: string
}

function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    input.length + ((4 - (input.length % 4)) % 4),
    '=',
  )
  return Buffer.from(padded, 'base64').toString('utf8')
}

export function validateAuthToken(input: unknown): JwtValidationResult {
  if (typeof input !== 'string') return { ok: false, expiresAt: null, reason: 'not-string' }
  const token = input.trim()
  if (token.length === 0 || token.length > MAX_JWT_LENGTH) {
    return { ok: false, expiresAt: null, reason: 'length' }
  }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, expiresAt: null, reason: 'not-jwt' }

  let header: JwtHeader
  let payload: JwtPayload
  try {
    header = JSON.parse(base64urlDecode(parts[0])) as JwtHeader
    payload = JSON.parse(base64urlDecode(parts[1])) as JwtPayload
  } catch {
    return { ok: false, expiresAt: null, reason: 'malformed-payload' }
  }

  // Supabase uses HS256 (legacy) or ES256/RS256. Reject "none" outright.
  if (!header.alg || header.alg.toLowerCase() === 'none') {
    return { ok: false, expiresAt: null, reason: 'bad-alg' }
  }

  if (typeof payload.exp !== 'number') {
    return { ok: false, expiresAt: null, reason: 'no-exp' }
  }
  const nowSec = Math.floor(Date.now() / 1000)
  const expMs = payload.exp * 1000

  if (nowSec > payload.exp + CLOCK_SKEW_SECONDS) {
    return { ok: false, expiresAt: expMs, reason: 'expired' }
  }
  if (typeof payload.nbf === 'number' && nowSec + CLOCK_SKEW_SECONDS < payload.nbf) {
    return { ok: false, expiresAt: expMs, reason: 'not-yet-valid' }
  }
  // Supabase tokens always include iat — require it so we can verify
  // both not-too-future-issued AND max lifetime against the real issue time.
  if (typeof payload.iat !== 'number') {
    return { ok: false, expiresAt: expMs, reason: 'no-iat' }
  }
  if (payload.iat > nowSec + CLOCK_SKEW_SECONDS) {
    return { ok: false, expiresAt: expMs, reason: 'iat-in-future' }
  }
  if (payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS) {
    return { ok: false, expiresAt: expMs, reason: 'lifetime-too-long' }
  }
  // Supabase tokens always set iss + aud. Require both.
  if (typeof payload.iss !== 'string' || !SUPABASE_ISSUER_PATTERN.test(payload.iss)) {
    return { ok: false, expiresAt: expMs, reason: 'bad-issuer' }
  }
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []
  if (!auds.includes('authenticated')) {
    return { ok: false, expiresAt: expMs, reason: 'bad-audience' }
  }
  if (typeof payload.sub !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.sub)) {
    return { ok: false, expiresAt: expMs, reason: 'bad-subject' }
  }

  return { ok: true, expiresAt: expMs, subject: payload.sub }
}

// Production proxy hosts — exact match, no wildcards. We deliberately do NOT
// allow `*.up.railway.app` because anyone can spin up a Railway project on
// that suffix and a misconfigured/leaked SPEAKFLOW_API_URL would forward
// the user's JWT and audio to an attacker.
const ALLOWED_PROXY_HOSTS = new Set<string>([
  'api.speakflow.app',
  'speakflow.app',
  'speakflow-marketing.vercel.app',
])

export function isProxyUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    return ALLOWED_PROXY_HOSTS.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

// ── ASR streaming WebSocket allowlist ───────────────────────────────────────
// The live-transcription socket carries raw microphone audio plus a Deepgram
// grant token. Exact-host, wss-only: the URL is built in-process from
// constants, so anything else reaching this check means a bug or tampering —
// refuse rather than stream audio to an unexpected endpoint.
const ASR_WS_HOST = 'api.deepgram.com'

export function isAsrWsUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'wss:') return false
    return parsed.hostname.toLowerCase() === ASR_WS_HOST
  } catch {
    return false
  }
}
