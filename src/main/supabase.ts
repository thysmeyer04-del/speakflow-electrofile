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
const supabaseUrl =
  process.env.SPEAKFLOW_SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
const supabaseAnonKey =
  process.env.SPEAKFLOW_SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  ''

// A long-lived anon client — used only for the rare unauth read. Writes go
// through clientForUser() which attaches the user JWT.
const anonClient: SupabaseClient | null =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, { realtime: REALTIME_TRANSPORT })
    : null

/** Authenticated client for the current user; falls back to null if no JWT. */
function clientForUser(): SupabaseClient | null {
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
export { anonClient as supabase }
