// Supabase sync engine — writes each transcript to the user_knowledge table
// (vector-embedded for semantic search). Differs from the dashboard's
// transcriptions-table writer: this one builds the RAG/knowledge index.
//
// Auth model: the dashboard hands its Supabase JWT to main via the auth
// bridge (ipc.ts). We attach that JWT to a per-request client so RLS
// (auth.uid() = user_id) authorizes the insert. Without this, every sync
// would silently 401 — the anon key has no auth context.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import WebSocket from 'ws'
import log from 'electron-log/main'
import { getAuthToken } from './ipc'

// Supabase JS eagerly initialises its realtime websocket inside createClient(),
// and Node 20 (Electron main) has no native WebSocket — so we hand it `ws`
// every time. Without this, the app crashes on startup as soon as
// SUPABASE_URL/ANON_KEY are set.
const REALTIME_TRANSPORT = { transport: WebSocket as unknown as typeof globalThis.WebSocket }

dotenv.config()

// Prefer the dashboard-style env names but fall back to the simpler ones so
// either naming works in .env.
//
// MUTABLE, and that matters. dotenv only ever finds a developer's local .env:
// `.env*` is gitignored and is not in electron-builder's `files:` list, so
// every PACKAGED build started with empty strings here. clientForUser() then
// returned null forever and refreshUserContext() took its silent early-return
// path on every tick — meaning the personal dictionary, snippets and
// pronunciation aliases NEVER loaded in any shipped build (diagnosed
// 2026-07-29 from a 5.5-hour log with zero [user-context] lines, while Thys
// was asking why "Supabase" kept transcribing as "supervise"). Measured
// impact of that dead path: proper-noun accuracy 5/24 vs 17/24.
//
// So when the env is empty we fetch the public client config from the
// marketing API at startup (see ensureSupabaseConfig). The anon key is public
// by design — the dashboard already ships it in its browser bundle, and RLS,
// not key secrecy, is what protects user data.
let supabaseUrl =
  process.env.SPEAKFLOW_SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
let supabaseAnonKey =
  process.env.SPEAKFLOW_SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

// A long-lived anon client — used only for the rare unauth read. Writes go
// through clientForUser() which attaches the user JWT. Built lazily so it can
// come to life after ensureSupabaseConfig() fills the credentials in.
let anonClient: SupabaseClient | null = null
function rebuildAnonClient(): void {
  anonClient =
    supabaseUrl && supabaseAnonKey
      ? createClient(supabaseUrl, supabaseAnonKey, { realtime: REALTIME_TRANSPORT })
      : null
}
rebuildAnonClient()

/** True once we have usable credentials from either source. */
export function hasSupabaseConfig(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey)
}

let configFetch: Promise<void> | null = null

/** Fill in missing credentials from the marketing API's public /api/config.
 *  No-op when the env already provided them (dev) or the proxy is unset.
 *  Never throws — callers fire-and-forget; a failure just leaves the caches
 *  empty exactly as before. */
export function ensureSupabaseConfig(proxyBaseUrl: string | null | undefined): Promise<void> {
  if (hasSupabaseConfig()) return Promise.resolve()
  if (!proxyBaseUrl) return Promise.resolve()
  if (configFetch) return configFetch

  configFetch = (async () => {
    try {
      const url = proxyBaseUrl.replace(/\/+$/, '') + '/config'
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`config ${res.status}`)
      const data = (await res.json()) as { supabaseUrl?: string; supabaseAnonKey?: string }
      if (!data.supabaseUrl || !data.supabaseAnonKey) throw new Error('config incomplete')
      supabaseUrl = data.supabaseUrl
      supabaseAnonKey = data.supabaseAnonKey
      rebuildAnonClient()
      log.info('[supabase] client credentials loaded from the API — dictionary sync enabled')
    } catch (err) {
      // Retry on the next call rather than latching a failure forever.
      configFetch = null
      log.warn('[supabase] could not load client credentials', err)
    }
  })()
  return configFetch
}

/** Authenticated client for the current user; falls back to null if no JWT.
 *  Exported so user-context (dictionary/snippets) fetches reuse the exact
 *  same RLS-authorized pattern as syncToKnowledgeBase. */
export function clientForUser(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null
  const token = getAuthToken()
  if (!token) return null
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: REALTIME_TRANSPORT,
  })
}

/** Sync a transcript to the user_knowledge table with its embedding. */
export async function syncToKnowledgeBase(
  text: string,
  userId: string,
  metadata: Record<string, unknown> = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseUrl || !supabaseAnonKey) {
    return { ok: false, error: 'no-credentials' }
  }
  const client = clientForUser()
  if (!client) {
    // No JWT yet — user hasn't signed in or token expired. Don't fail loudly.
    log.warn('[supabase] skipping sync — no auth token (not signed in yet?)')
    return { ok: false, error: 'no-auth' }
  }

  try {
    // Lazy-load the embedder so we don't pay its cost in main-process startup.
    const { generateEmbedding } = await import('./embeddings')
    const embedding = await generateEmbedding(text)

    const { error } = await client.from('user_knowledge').insert([
      {
        user_id: userId,
        content: text,
        embedding,
        metadata: {
          ...metadata,
          source: 'speakflow-desktop',
          timestamp: new Date().toISOString(),
        },
      },
    ])

    if (error) {
      log.error('[supabase] insert failed:', error.message, 'code=', error.code)
      return { ok: false, error: error.message }
    }
    log.info('[supabase] transcript synced to knowledge base')
    return { ok: true }
  } catch (err) {
    log.error('[supabase] sync threw:', (err as Error).message)
    return { ok: false, error: (err as Error).message }
  }
}

// Expose the (rarely-used) anon client for reads that don't need auth.
// A function, not a re-exported binding: tsc compiles `export { anonClient }`
// to a one-time `exports.supabase = anonClient` snapshot, which would hand
// callers the null captured before ensureSupabaseConfig() ran.
export function getAnonClient(): SupabaseClient | null {
  return anonClient
}
