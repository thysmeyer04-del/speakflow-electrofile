// Chat-completion client for Transform commands and smart formatting.
//
// Packaged builds route through the Speakflow API proxy (/api/transform) with
// the user's auth token — same pattern as transcribe.ts. Dev builds call Groq
// directly with GROQ_API_KEY. Mirrors transcribe.ts's error-mapping + timeout
// patterns. Returns the assistant's trimmed message content. Supports
// per-call AbortSignal so the caller can cancel mid-flight (e.g. user presses
// F11 to start a recording while a transform is still resolving).

import log from 'electron-log/main'
import { getAuthToken } from './ipc'
import { getProxyBaseUrl } from './transcribe'
import { isProxyUrlAllowed } from './security'

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'
// Transform commands default to Groq's 2026 flagship writer (Thys, 2026-07-17:
// email/prompt quality over speed here — transforms are hotkey-triggered, not
// on the dictation hot path, so ~1-2 s is fine). Formatting is NOT affected:
// format-transcript.ts passes its own 8b model explicitly. Per-command
// `model` still overrides; env knob for emergencies/A-B. Swapping the whole
// product to another provider later = change this constant + server allowlist.
const DEFAULT_MODEL = process.env.SPEAKFLOW_TRANSFORM_MODEL || 'openai/gpt-oss-120b'
const REQUEST_TIMEOUT_MS = 30_000

export async function transformText(
  systemPrompt: string,
  userText: string,
  model: string = DEFAULT_MODEL,
  signal?: AbortSignal,
  temperature: number = 0.3,
): Promise<string> {
  // Compose own AbortController so we can union an external signal with our
  // own timeout. AbortSignal.any() is Node 20+, so do this manually.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const proxyUrl = getProxyBaseUrl()
    if (proxyUrl) {
      if (!isProxyUrlAllowed(proxyUrl)) {
        throw new Error('Speakflow API URL is not allowed.')
      }
      return await transformViaProxy(
        proxyUrl, systemPrompt, userText, model, temperature, controller.signal,
      )
    }
    return await transformViaGroq(
      systemPrompt, userText, model, temperature, controller.signal,
    )
  } finally {
    clearTimeout(timer)
  }
}

async function transformViaProxy(
  baseUrl: string,
  systemPrompt: string,
  userText: string,
  model: string,
  temperature: number,
  signal: AbortSignal,
): Promise<string> {
  const token = getAuthToken()
  if (!token) {
    throw new Error('Sign in via the dashboard to use Speakflow.')
  }

  const url = baseUrl.replace(/\/+$/, '') + '/transform'
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ systemPrompt, userText, model, temperature }),
      signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Transform aborted.')
    }
    throw new Error('Could not reach the Speakflow API.')
  }

  if (!response.ok) {
    const body = await safeReadBody(response)
    log.error(`[transform-llm] proxy error ${response.status}`, body.slice(0, 500))
    throw new Error(userMessageForStatus(response.status))
  }

  const data = (await response.json()) as { text?: string; error?: string }
  const text = data.text?.trim() ?? ''
  if (!text) {
    throw new Error('Transform returned empty result.')
  }
  return text
}

async function transformViaGroq(
  systemPrompt: string,
  userText: string,
  model: string,
  temperature: number,
  signal: AbortSignal,
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set. Add it to .env for local development.')
  }

  let response: Response
  try {
    response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        temperature,
        max_tokens: 2048,
      }),
      signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Transform aborted.')
    }
    throw new Error('Could not reach Groq. Check your internet connection.')
  }

  if (!response.ok) {
    const body = await safeReadBody(response)
    log.error(`[transform-llm] Groq error ${response.status}`, body.slice(0, 500))
    throw new Error(userMessageForStatus(response.status))
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const text = data.choices?.[0]?.message?.content?.trim() ?? ''
  if (!text) {
    throw new Error('Transform returned empty result.')
  }
  return text
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1024)
  } catch {
    return ''
  }
}

function userMessageForStatus(status: number): string {
  if (status === 401) return 'Authentication failed. Check GROQ_API_KEY.'
  if (status === 402) return 'Weekly free limit reached — upgrade to Pro in your Speakflow dashboard'
  if (status === 403) return 'Plan limit reached on Groq.'
  if (status === 413) return 'Selected text is too long for transform.'
  if (status === 429) return 'Groq rate limit hit. Wait a moment and try again.'
  if (status >= 500) return 'Groq is temporarily unavailable.'
  return 'Transform failed. Try again.'
}
