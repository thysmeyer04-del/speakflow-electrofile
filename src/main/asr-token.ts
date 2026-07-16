// Deepgram grant-token client for True Streaming (POST /api/asr-token).
//
// The desktop app never holds a long-lived Deepgram key: it exchanges the
// user's Supabase JWT for a short-lived grant token via the Speakflow proxy,
// and that grant is what authenticates the live WebSocket. The proxy enforces
// quota (402) at mint time, so a word-limited user never even opens a socket.
//
// Contract (FROZEN, coordinated with the server team — code against this,
// not their repo):
//   POST ${proxyBase}/asr-token   Bearer <Supabase JWT>, empty body
//   200 → { token: string, expiresAt: epochMs, provider: 'deepgram' }
//   401 {error} · 402 {error:'word_limit_reached',...} ·
//   502 {error:'grant_failed'} · 503 {error:'streaming_not_configured'}
//
// This module also hosts the shared typed-error helper for the whole ASR
// stack and the tiny /usage beacon — all three are "streaming plumbing that
// talks to the proxy", and keeping them together avoids a third file whose
// only content would be an error interface.

import log from 'electron-log/main'
import { getAuthToken } from './ipc'
import { isProxyUrlAllowed } from './security'
import {
  getProxyBaseUrl,
  fetchWithTimeout,
  safeReadBody,
  userMessageForStatus,
} from './transcribe'

// ── Typed errors ────────────────────────────────────────────────────────────
// Same pattern as dictate.ts's DictateHttpError: a plain Error with a code
// property, so callers branch on `asrErrorCode(err)` instead of string-
// matching messages. Codes are the exact fallback reasons the [timing] logs
// need — one vocabulary end to end.
export type AsrErrorCode =
  | 'quota'            // 402 at mint — the user's weekly word limit is spent
  | 'not-configured'   // 503 at mint — server has no streaming credentials
  | 'mint-failed'      // any other mint failure (network, 401, 5xx, bad body)
  | 'connect-failed'   // WebSocket never reached 'open'
  | 'ws-error'         // socket died / unusable after open
  | 'finalize-timeout' // Finalize sent but no flush final within the budget
  | 'aborted'          // session invalidated (sign-out, crash, new session)

export interface AsrError extends Error {
  asrCode: AsrErrorCode
}

export function asrError(code: AsrErrorCode, message: string): AsrError {
  const err = new Error(message) as AsrError
  err.asrCode = code
  return err
}

/** Extract the typed code from any thrown value (null for foreign errors). */
export function asrErrorCode(err: unknown): AsrErrorCode | null {
  const code = (err as AsrError | null)?.asrCode
  return typeof code === 'string' ? code : null
}

// ── Grant-token cache ───────────────────────────────────────────────────────
const MINT_TIMEOUT_MS = 10_000
// Reuse the cached grant only while it has comfortably more life left than a
// WebSocket handshake takes — a token that expires mid-connect buys nothing.
const TOKEN_REUSE_MARGIN_MS = 15_000

let cached: { token: string; expiresAt: number } | null = null

/** Called from the auth handlers in ipc.ts whenever the Supabase token is set
 *  or cleared: a grant minted for the previous identity must never be reused
 *  by the next one (and after a plain refresh, re-minting is one cheap call). */
export function clearAsrToken(): void {
  cached = null
}

export async function getAsrToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > TOKEN_REUSE_MARGIN_MS) {
    return cached.token
  }
  cached = null

  const base = getProxyBaseUrl()
  if (!base) throw asrError('mint-failed', 'Speakflow API is not configured.')
  if (!isProxyUrlAllowed(base)) {
    throw asrError('mint-failed', 'Speakflow API URL is not allowed.')
  }
  const auth = getAuthToken()
  if (!auth) throw asrError('mint-failed', 'Not signed in — no JWT for /asr-token.')

  const url = base.replace(/\/+$/, '') + '/asr-token'
  const t0 = Date.now()
  let response: Response
  try {
    response = await fetchWithTimeout(
      url,
      // Empty body per the frozen contract — everything the server needs is
      // in the Bearer JWT.
      { method: 'POST', headers: { Authorization: `Bearer ${auth}` } },
      MINT_TIMEOUT_MS,
    )
  } catch (err) {
    throw asrError(
      'mint-failed',
      (err as Error).name === 'AbortError'
        ? 'asr-token mint timed out'
        : 'Could not reach the Speakflow API for /asr-token.',
    )
  }

  if (!response.ok) {
    const body = await safeReadBody(response)
    log.warn(`[asr] token mint failed ${response.status}: ${body.slice(0, 300)}`)
    // 402 carries the SAME user-facing wording as the batch quota path —
    // callers may surface it, and two different limit messages would read
    // like two different limits.
    if (response.status === 402) throw asrError('quota', userMessageForStatus(402))
    if (response.status === 503) {
      throw asrError('not-configured', 'Streaming is not configured on the server.')
    }
    throw asrError('mint-failed', `asr-token mint returned ${response.status}`)
  }

  let data: { token?: unknown; expiresAt?: unknown; provider?: unknown }
  try {
    data = (await response.json()) as typeof data
  } catch {
    throw asrError('mint-failed', 'asr-token response was not JSON')
  }
  if (typeof data.token !== 'string' || data.token.length === 0 || data.token.length > 4096) {
    throw asrError('mint-failed', 'asr-token response missing a usable token')
  }
  const expiresAt =
    typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt)
      ? data.expiresAt
      : 0
  // Cache even a short-lived grant — the reuse margin above decides whether
  // it's still worth anything on the next dictation.
  cached = { token: data.token, expiresAt }
  log.info(
    `[timing] asr token mint ${Date.now() - t0}ms (ttl=${
      expiresAt > 0 ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) + 's' : 'unknown'
    })`,
  )
  return data.token
}

// ── Streaming usage beacon ──────────────────────────────────────────────────
// The batch /dictate path meters words server-side as a side effect of the
// upload; the streaming path never uploads, so it must self-report or the
// weekly quota silently stops counting streamed dictations. Fire-and-forget
// by design: a lost beacon must never delay or fail a dictation the user has
// already received.
const USAGE_TIMEOUT_MS = 5_000

export function reportStreamingUsage(opts: { audioSeconds: number; words: number }): void {
  const base = getProxyBaseUrl()
  const token = getAuthToken()
  if (!base || !isProxyUrlAllowed(base) || !token) return
  const url = base.replace(/\/+$/, '') + '/usage'
  void fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        engine: 'deepgram-streaming',
        audioSeconds: Math.round(opts.audioSeconds),
        words: opts.words,
      }),
    },
    USAGE_TIMEOUT_MS,
  )
    .then((res) => {
      if (!res.ok) log.warn(`[asr] usage report rejected: ${res.status}`)
    })
    .catch((err) => log.warn('[asr] usage report failed (logged only)', err))
}
