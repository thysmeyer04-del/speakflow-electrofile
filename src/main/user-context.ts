// Personal dictionary + snippets cache (Wispr Flow parity).
//
// Pulls the user's dictionary_words and snippets rows from Supabase (RLS =
// user-owns-rows, so the JWT-authed client from supabase.ts scopes the query
// automatically) and keeps them in memory for the hot dictation path:
//   - dictionary words bias Whisper spelling via the transcription prompt
//   - dictionary words are handed to the format LLM as preferred spellings
//   - snippet triggers are expanded after formatting, before inject
//
// Everything here fails OPEN: no auth token, no network, no Supabase creds —
// dictation proceeds with empty caches. This module must never block or fail
// a dictation.

import log from 'electron-log/main'
import { getAuthToken } from './ipc'
import { clientForUser } from './supabase'

export interface Snippet {
  trigger: string
  expansion: string
}

const REFRESH_INTERVAL_MS = 5 * 60_000
const MAX_DICTIONARY_WORDS = 200
// Whisper prompt budget — a long prompt starts steering content, not spelling.
const MAX_PROMPT_WORDS = 25
const MAX_PROMPT_CHARS = 200

// Most-recent-first (ordered by created_at desc at fetch time).
let dictionaryWords: string[] = []
let snippets: Snippet[] = []
let refreshInFlight = false

export function getDictionaryWords(): string[] {
  return dictionaryWords
}

export function getSnippets(): Snippet[] {
  return snippets
}

/** Whisper `prompt` field: up to 25 most recent dictionary words, ≤200 chars.
 *  Empty string when the user has no dictionary (caller falls back to ' '). */
export function getWhisperPrompt(): string {
  if (dictionaryWords.length === 0) return ''
  let prompt = ''
  for (const word of dictionaryWords.slice(0, MAX_PROMPT_WORDS)) {
    const next = prompt ? `${prompt}, ${word}` : word
    if (next.length > MAX_PROMPT_CHARS) break
    prompt = next
  }
  return prompt
}

/** Clear caches (sign-out) so one user's words never leak into another's session. */
export function clearUserContext(): void {
  dictionaryWords = []
  snippets = []
}

/** Fetch dictionary + snippets for the signed-in user. Silent no-op without
 *  a token. Never throws — callers fire-and-forget. */
export async function refreshUserContext(): Promise<void> {
  if (refreshInFlight) return
  const client = clientForUser()
  if (!client) return // not signed in (or no Supabase creds) — keep quiet
  refreshInFlight = true
  try {
    const [wordsRes, snippetsRes] = await Promise.all([
      client
        .from('dictionary_words')
        .select('word')
        .order('created_at', { ascending: false })
        .limit(MAX_DICTIONARY_WORDS),
      client.from('snippets').select('trigger_phrase, expansion'),
    ])

    if (wordsRes.error) {
      log.warn('[user-context] dictionary fetch failed:', wordsRes.error.message)
    } else {
      dictionaryWords = (wordsRes.data ?? [])
        .map((r) => (typeof r.word === 'string' ? r.word.trim() : ''))
        .filter(Boolean)
    }

    if (snippetsRes.error) {
      log.warn('[user-context] snippets fetch failed:', snippetsRes.error.message)
    } else {
      snippets = (snippetsRes.data ?? [])
        .map((r) => ({
          trigger: typeof r.trigger_phrase === 'string' ? r.trigger_phrase.trim() : '',
          expansion: typeof r.expansion === 'string' ? r.expansion : '',
        }))
        .filter((s) => s.trigger && s.expansion)
    }

    log.info(
      `[user-context] refreshed: ${dictionaryWords.length} dictionary word(s), ${snippets.length} snippet(s)`,
    )
  } catch (err) {
    log.warn('[user-context] refresh threw (ignored)', err)
  } finally {
    refreshInFlight = false
  }
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replace standalone snippet triggers with their expansions.
 *  Only triggers that are 2+ words or ≥5 chars qualify — a 3-letter trigger
 *  like "sig" would false-positive inside ordinary dictation too easily. */
export function expandSnippets(text: string): string {
  if (snippets.length === 0 || !text) return text
  let out = text
  for (const { trigger, expansion } of snippets) {
    const isMultiWord = /\s/.test(trigger)
    if (!isMultiWord && trigger.length < 5) continue
    try {
      const re = new RegExp(`\\b${escapeRegExp(trigger).replace(/\s+/g, '\\s+')}\\b`, 'gi')
      out = out.replace(re, expansion)
    } catch {
      // A pathological trigger that still breaks RegExp — skip it.
    }
  }
  return out
}

// Periodic refresh so dashboard edits show up without an app restart. The
// tick is a no-op while signed out (clientForUser() returns null). unref so
// the timer never keeps the process alive at quit.
const refreshTimer = setInterval(() => {
  if (getAuthToken()) void refreshUserContext()
}, REFRESH_INTERVAL_MS)
refreshTimer.unref?.()
