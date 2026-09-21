export type Cleanup = 'verbatim' | 'clean' | 'rewrite'
export type WritingStyle = 'preserve' | 'professional' | 'casual'
export interface DictationPreferences {
  cleanup: Cleanup
  hotkeyMode: 'toggle' | 'hold'
  cleanupEngine: 'cloud' | 'offline'
  speed: 'balanced' | 'fast'
  email: WritingStyle
  messaging: WritingStyle
  code: WritingStyle
  other: WritingStyle
  retainOriginals: boolean
}
export const defaultPreferences: DictationPreferences = {
  cleanup: 'clean', hotkeyMode: 'toggle', cleanupEngine: 'cloud', speed: 'balanced',
  email: 'preserve', messaging: 'preserve', code: 'preserve', other: 'preserve', retainOriginals: true,
}
export function validatePreferences(input: unknown): DictationPreferences | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const x = input as Record<string, unknown>
  const choices: Record<string, readonly string[]> = {
    cleanup: ['verbatim', 'clean', 'rewrite'], hotkeyMode: ['toggle', 'hold'],
    cleanupEngine: ['cloud', 'offline'], speed: ['balanced', 'fast'],
    email: ['preserve', 'professional', 'casual'], messaging: ['preserve', 'professional', 'casual'],
    code: ['preserve', 'professional', 'casual'], other: ['preserve', 'professional', 'casual'],
  }
  if (Object.keys(x).some(k => !Object.prototype.hasOwnProperty.call(defaultPreferences, k))) return null
  for (const [key, values] of Object.entries(choices)) if (!values.includes(x[key] as string)) return null
  if (typeof x.retainOriginals !== 'boolean') return null
  return x as unknown as DictationPreferences
}

export function applyCorrections(text: string, corrections: { from: string; to: string }[]): string {
  if (!corrections.length) return text
  const sorted = [...corrections].sort((a, b) => b.from.length - a.from.length)
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${sorted.map(c => escape(c.from)).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
  const values = new Map(sorted.map(c => [c.from.toLocaleLowerCase(), c.to]))
  return text.replace(pattern, match => values.get(match.toLocaleLowerCase()) ?? match)
}

/** Offline formatting executes explicit structure only; no inferred rewrite. */
export function offlineCleanup(text: string): string {
  let out = text.replace(/\b(?:start a )?new paragraph\b[,.]?\s*/gi, '\n\n')
    .replace(/\b(?:new line|next line|line break)\b[,.]?\s*/gi, '\n')
    .replace(/\b(?:next bullet|bullet point)\b[,:.]?\s*/gi, '\n- ')
  const matches = [...out.matchAll(/\b(?:number|step)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b[,:.]?\s*/gi)]
  const words = ['one','two','three','four','five','six','seven','eight','nine','ten']
  if (matches.length >= 2 && matches.every((m, i) => (words.indexOf(m[1].toLowerCase()) + 1 || Number(m[1])) === i + 1)) {
    let index = 0
    out = out.replace(/\b(?:number|step)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b[,:.]?\s*/gi, () => `\n${++index}. `)
  }
  return out.replace(/[^\S\r\n]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
