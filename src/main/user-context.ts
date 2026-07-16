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
import { COMMON_WORDS } from './common-words'

export interface Snippet {
  trigger: string
  expansion: string
}

export interface Pronunciation {
  spelling: string
  aliases: string[] // stored normalized (lowercase, no punctuation)
}

const REFRESH_INTERVAL_MS = 5 * 60_000
const MAX_DICTIONARY_WORDS = 200
const MAX_PRONUNCIATIONS = 100
const MAX_ALIASES_PER_WORD = 8
// Whisper prompt budget — a long prompt starts steering content, not spelling.
const MAX_PROMPT_WORDS = 25
const MAX_PROMPT_CHARS = 200

// Most-recent-first (ordered by created_at desc at fetch time).
let dictionaryWords: string[] = []
let snippets: Snippet[] = []
let pronunciations: Pronunciation[] = []
// Compiled once per refresh, not per dictation: [regex, spelling] pairs.
let aliasMatchers: Array<{ re: RegExp; spelling: string; spellingRe: RegExp }> = []
let refreshInFlight = false

export function getDictionaryWords(): string[] {
  return dictionaryWords
}

export function getSnippets(): Snippet[] {
  return snippets
}

/** Pronunciation-trained spellings — highest-priority ASR bias terms
 *  (Deepgram keyterm params on the stream path, Whisper prompt head). */
export function getPronunciationSpellings(): string[] {
  return pronunciations.map((p) => p.spelling)
}

/** Whisper `prompt` field: pronunciation-trained spellings FIRST (the user
 *  explicitly trained these — they must never age out of the budget as the
 *  dictionary grows), then most recent dictionary words. ≤25 words/200 chars.
 *  Empty string when there is nothing (caller falls back to ' '). */
export function getWhisperPrompt(): string {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const word of [...getPronunciationSpellings(), ...dictionaryWords]) {
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(word)
    if (terms.length >= MAX_PROMPT_WORDS) break
  }
  if (terms.length === 0) return ''
  let prompt = ''
  for (const word of terms) {
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
  pronunciations = []
  aliasMatchers = []
}

/** Fetch dictionary + snippets for the signed-in user. Silent no-op without
 *  a token. Never throws — callers fire-and-forget. */
export async function refreshUserContext(): Promise<void> {
  if (refreshInFlight) return
  const client = clientForUser()
  if (!client) return // not signed in (or no Supabase creds) — keep quiet
  refreshInFlight = true
  try {
    const [wordsRes, snippetsRes, pronRes] = await Promise.all([
      client
        .from('dictionary_words')
        .select('word')
        .order('created_at', { ascending: false })
        .limit(MAX_DICTIONARY_WORDS),
      client.from('snippets').select('trigger_phrase, expansion'),
      client
        .from('pronunciations')
        .select('spelling, aliases')
        .order('created_at', { ascending: false })
        .limit(MAX_PRONUNCIATIONS),
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

    if (pronRes.error) {
      // Table may not exist yet on older DBs — quietly keep the empty cache.
      log.warn('[user-context] pronunciations fetch failed:', pronRes.error.message)
    } else {
      pronunciations = (pronRes.data ?? [])
        .map((r) => ({
          spelling: typeof r.spelling === 'string' ? r.spelling.trim() : '',
          aliases: Array.isArray(r.aliases)
            ? r.aliases
                .filter((a): a is string => typeof a === 'string')
                .map((a) => a.trim())
                .filter(Boolean)
                .slice(0, MAX_ALIASES_PER_WORD)
            : [],
        }))
        .filter((p) => p.spelling)
      rebuildAliasMatchers()
    }

    log.info(
      `[user-context] refreshed: ${dictionaryWords.length} dictionary word(s), ${snippets.length} snippet(s), ${pronunciations.length} pronunciation(s)`,
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

// ── Pronunciation alias correction (v0.7.0) ────────────────────────────────
// The dashboard filters candidates at harvest time; these are defensive
// re-checks at application time — a hand-edited DB row must never be able to
// corrupt dictations. Same guards, applied independently.
function rebuildAliasMatchers(): void {
  const matchers: typeof aliasMatchers = []
  for (const { spelling, aliases } of pronunciations) {
    let spellingRe: RegExp
    try {
      spellingRe = new RegExp(`\\b${escapeRegExp(spelling)}\\b`, 'i')
    } catch {
      continue
    }
    for (const alias of aliases) {
      if (alias.length < 3) continue
      if (COMMON_WORDS.has(alias.toLowerCase())) continue
      if (alias.toLowerCase() === spelling.toLowerCase()) continue
      try {
        matchers.push({
          re: new RegExp(`\\b${escapeRegExp(alias).replace(/\s+/g, '\\s+')}\\b`, 'gi'),
          spelling,
          spellingRe,
        })
      } catch {
        // Pathological alias that still breaks RegExp — skip it.
      }
    }
  }
  aliasMatchers = matchers
}

/** Replace trained mis-hearings with the user's intended spelling
 *  ("tice" → "Thys"). Whole-word, case-insensitive; output is the canonical
 *  stored spelling (correct for proper nouns — the primary use case).
 *  Skips a pronunciation entirely when its spelling already appears in the
 *  text: the ASR bias already won, so an alias-shaped word elsewhere in the
 *  same dictation is more likely genuine. Never throws, never empties. */
export function applyPronunciationAliases(text: string): string {
  if (aliasMatchers.length === 0 || !text) return text
  let out = text
  let applied = 0
  for (const { re, spelling, spellingRe } of aliasMatchers) {
    if (spellingRe.test(out)) continue
    re.lastIndex = 0
    const next = out.replace(re, () => {
      applied++
      return spelling
    })
    out = next
  }
  if (applied > 0) log.info(`[pronunciation] applied ${applied} alias fix(es)`)
  return out
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
