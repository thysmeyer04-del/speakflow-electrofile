// electron-store wrapper for user-defined Transform commands.
//
// A Command is a hotkey-triggered LLM transform: highlight text → press
// Win+Alt+N (Cmd+Alt+N on macOS) → text replaced by the LLM's rewrite using
// `prompt` as the system message.
//
// Seeded defaults: Email (1), Prompt Engineer (2). User may edit, add up to
// hotkey number 9, or reset.

import Store from 'electron-store'
import { randomUUID } from 'crypto'
import log from 'electron-log/main'

export interface Command {
  id: string
  name: string
  description: string
  prompt: string
  hotkeyNumber: number // 1-9
  model?: string
  order: number
  isSeeded: boolean
}

interface CommandsStoreSchema {
  commands: Command[]
}

const DEFAULTS: Command[] = [
  {
    id: 'seed-email',
    name: 'Email',
    description: 'Rewrite as a clear professional email',
    prompt:
      "You are an email composer. Rewrite the user's text as a clear professional email. Preserve intent. Add greeting/signoff only if appropriate to the content. Output ONLY the email — no markdown, no preamble, no commentary.",
    hotkeyNumber: 1,
    order: 0,
    isSeeded: true,
  },
  {
    id: 'seed-prompt-engineer',
    name: 'Prompt Engineer',
    description: 'Turn rough notes into a structured AI prompt',
    prompt:
      "You are an expert prompt engineer. Rewrite the user's rough description as a structured AI prompt specifying: role/persona, task, input/context, desired output format, and any constraints. Output ONLY the rewritten prompt — no preamble, no commentary.",
    hotkeyNumber: 2,
    order: 1,
    isSeeded: true,
  },
  {
    id: 'seed-polish',
    name: 'Polish',
    description: 'Fix grammar and phrasing while keeping your voice',
    prompt:
      "Clean up this text: fix grammar, punctuation and awkward phrasing. Keep the original voice and meaning exactly. Output ONLY the corrected text — no preamble, no commentary.",
    hotkeyNumber: 3,
    order: 2,
    isSeeded: true,
  },
]

const store = new Store<CommandsStoreSchema>({
  name: 'speakflow-commands',
  defaults: { commands: DEFAULTS },
  clearInvalidConfig: true,
})

export function initCommandsStore(): void {
  // Idempotent: only seed when key truly absent. We do NOT re-seed when the
  // user has emptied their list deliberately.
  const existing = store.get('commands') as Command[] | undefined
  if (!Array.isArray(existing)) {
    store.set('commands', DEFAULTS)
    log.info(`[commands] seeded ${DEFAULTS.length} default commands on first run`)
  }
}

export function getCommands(): Command[] {
  const list = (store.get('commands') as Command[] | undefined) ?? []
  return [...list].sort((a, b) => a.order - b.order)
}

export function getCommand(id: string): Command | undefined {
  return getCommands().find((c) => c.id === id)
}

export interface SaveResult {
  success: boolean
  error?: string
  command?: Command
}

// Generous caps — Groq context is 128k tokens so prompts up to 8 KB are fine.
// Caps stop a malicious renderer from quietly storing a 10 MB prompt that
// would later torch the user's Groq quota on each transform invocation.
const MAX_NAME_LEN = 80
const MAX_DESC_LEN = 240
const MAX_PROMPT_LEN = 8_000

export function saveCommand(input: Partial<Command>): SaveResult {
  const name = input.name?.trim()
  const prompt = input.prompt?.trim()
  if (!name) return { success: false, error: 'name-required' }
  if (!prompt) return { success: false, error: 'prompt-required' }
  if (name.length > MAX_NAME_LEN) return { success: false, error: 'name-too-long' }
  if (prompt.length > MAX_PROMPT_LEN) return { success: false, error: 'prompt-too-long' }
  const desc = input.description?.trim()
  if (desc && desc.length > MAX_DESC_LEN) return { success: false, error: 'description-too-long' }
  if (
    typeof input.hotkeyNumber !== 'number' ||
    !Number.isInteger(input.hotkeyNumber) ||
    input.hotkeyNumber < 1 ||
    input.hotkeyNumber > 9
  ) {
    return { success: false, error: 'hotkey-number-out-of-range' }
  }

  const commands = getCommands()
  // Hotkey uniqueness — must not collide with another command's number.
  const collision = commands.find(
    (other) => other.id !== input.id && other.hotkeyNumber === input.hotkeyNumber,
  )
  if (collision) {
    return { success: false, error: `hotkey-conflict:${collision.name}` }
  }

  const existingIdx = input.id ? commands.findIndex((c) => c.id === input.id) : -1
  let final: Command
  if (existingIdx >= 0) {
    const prev = commands[existingIdx]
    final = {
      ...prev,
      name,
      description: input.description?.trim() ?? prev.description,
      prompt,
      hotkeyNumber: input.hotkeyNumber,
      model: input.model?.trim() || prev.model,
    }
    commands[existingIdx] = final
  } else {
    final = {
      id: input.id || randomUUID(),
      name,
      description: input.description?.trim() ?? '',
      prompt,
      hotkeyNumber: input.hotkeyNumber,
      model: input.model?.trim(),
      order: input.order ?? commands.length,
      isSeeded: false,
    }
    commands.push(final)
  }

  store.set('commands', commands)
  return { success: true, command: final }
}

export function deleteCommand(id: string): void {
  const next = getCommands().filter((c) => c.id !== id)
  store.set('commands', next)
}

export function resetToDefaults(): void {
  store.set('commands', DEFAULTS)
}
