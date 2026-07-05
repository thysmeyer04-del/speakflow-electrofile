// One-shot migration: imports Wispr Flow transcripts (already extracted to
// `~/AppData/Roaming/speakflow-desktop/wispr-import.json` by
// scripts/extract-wispr-history.py) into Speakflow's RAG memory via the same
// path live transcripts use: generate embedding → insert into
// `user_knowledge` with the user's JWT.
//
// Idempotent: queries existing rows where metadata->>source = 'wispr-flow'
// and skips wispr_ids that already imported. Safe to re-run.
//
// Progress is broadcast on the `migrate:progress` IPC channel so the
// dashboard (or DevTools console) can observe.

import fs from 'fs/promises'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { getAuthToken } from './ipc'

// See supabase.ts for why we hand `ws` to Supabase JS in main process.
const REALTIME_TRANSPORT = { transport: WebSocket as unknown as typeof globalThis.WebSocket }

interface WisprTranscript {
  wisprId: string
  text: string
  timestamp: string | null
  app: string | null
  numWords: number
  duration: number | null
  language: string | null
}

interface WisprImportFile {
  source: string
  extractedAt: string
  count: number
  totalWords: number
  transcripts: WisprTranscript[]
}

export interface MigrateProgress {
  imported: number
  skipped: number
  failed: number
  total: number
  done: boolean
  error?: string
}

const BATCH_SIZE = 25

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

let inProgress = false

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

function getUserIdFromToken(): string | null {
  const token = getAuthToken()
  if (!token) return null
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    )
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

function broadcast(channel: string, payload?: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

export function isWisprMigrationRunning(): boolean {
  return inProgress
}

export async function runWisprMigration(
  jsonPath?: string,
): Promise<MigrateProgress> {
  if (inProgress) {
    return {
      imported: 0, skipped: 0, failed: 0, total: 0, done: true,
      error: 'already-running',
    }
  }
  inProgress = true

  try {
    const src =
      jsonPath || path.join(app.getPath('userData'), 'wispr-import.json')
    let raw: string
    try {
      raw = await fs.readFile(src, 'utf-8')
    } catch (err) {
      return {
        imported: 0, skipped: 0, failed: 0, total: 0, done: true,
        error: `import-file-missing: ${(err as Error).message}`,
      }
    }

    const data: WisprImportFile = JSON.parse(raw)
    log.info(
      `[migrate-wispr] loaded ${data.count} transcripts (${data.totalWords} words) from ${src}`,
    )

    if (!supabaseUrl || !supabaseAnonKey) {
      log.error('[migrate-wispr] missing SUPABASE_URL / SUPABASE_ANON_KEY in .env')
      return {
        imported: 0, skipped: 0, failed: 0, total: data.count, done: true,
        error: 'no-supabase-credentials',
      }
    }
    const userId = getUserIdFromToken()
    if (!userId) {
      log.error('[migrate-wispr] no JWT in main process — sign in to the dashboard first')
      return {
        imported: 0, skipped: 0, failed: 0, total: data.count, done: true,
        error: 'not-signed-in',
      }
    }
    const client = clientForUser()
    if (!client) {
      return {
        imported: 0, skipped: 0, failed: 0, total: data.count, done: true,
        error: 'client-init-failed',
      }
    }

    // Idempotency — pull every wispr_id we've already imported for this user.
    // The metadata filter syntax: `metadata->>source = 'wispr-flow'`.
    const { data: existing, error: queryError } = await client
      .from('user_knowledge')
      .select('metadata')
      .eq('user_id', userId)
      .filter('metadata->>source', 'eq', 'wispr-flow')

    if (queryError) {
      log.error('[migrate-wispr] existence query failed', queryError)
      return {
        imported: 0, skipped: 0, failed: 0, total: data.count, done: true,
        error: queryError.message,
      }
    }

    const alreadyImported = new Set<string>(
      ((existing ?? []) as Array<{ metadata?: { wispr_id?: string } }>)
        .map((r) => r.metadata?.wispr_id)
        .filter((v): v is string => typeof v === 'string'),
    )
    log.info(`[migrate-wispr] ${alreadyImported.size} already imported; will skip`)

    const { generateEmbedding } = await import('./embeddings')

    let imported = 0
    let skipped = 0 // counted at iteration time
    let failed = 0

    for (let i = 0; i < data.transcripts.length; i += BATCH_SIZE) {
      const batch = data.transcripts.slice(i, i + BATCH_SIZE)
      const rows: Record<string, unknown>[] = []

      for (const t of batch) {
        if (!t.text?.trim()) continue
        if (alreadyImported.has(t.wisprId)) {
          skipped++
          continue
        }
        try {
          const embedding = await generateEmbedding(t.text)
          rows.push({
            user_id: userId,
            content: t.text,
            embedding,
            metadata: {
              source: 'wispr-flow',
              wispr_id: t.wisprId,
              app_name: t.app,
              word_count: t.numWords,
              language: t.language,
              original_timestamp: t.timestamp,
              timestamp: new Date().toISOString(),
            },
          })
        } catch (err) {
          log.warn(`[migrate-wispr] embedding failed for ${t.wisprId}:`, err)
          failed++
        }
      }

      if (rows.length > 0) {
        const { error } = await client.from('user_knowledge').insert(rows)
        if (error) {
          log.error(`[migrate-wispr] insert batch ${i / BATCH_SIZE} failed`, error)
          failed += rows.length
        } else {
          imported += rows.length
        }
      }

      broadcast('migrate:progress', {
        imported, skipped, failed, total: data.count, done: false,
      } as MigrateProgress)

      // Yield to event loop so F11 / overlay paint stay responsive.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    const final: MigrateProgress = {
      imported, skipped, failed, total: data.count, done: true,
    }
    log.info(
      `[migrate-wispr] DONE imported=${imported} skipped=${skipped} failed=${failed} total=${data.count}`,
    )
    broadcast('migrate:progress', final)
    return final
  } catch (err) {
    log.error('[migrate-wispr] threw', err)
    const final: MigrateProgress = {
      imported: 0, skipped: 0, failed: 0, total: 0, done: true,
      error: (err as Error).message,
    }
    broadcast('migrate:progress', final)
    return final
  } finally {
    inProgress = false
  }
}
