import { validateFormattedTranscript, decideFormattedText } from './format-transcript'
import { toneInstruction, type Command } from './commands-store'

export function commandPrompt(command: Command): string {
  const prompt = command.prompt + toneInstruction(command.tone)
  if (!['seed-email', 'seed-prompt-engineer', 'seed-polish'].includes(command.id)) return prompt
  return prompt + '\n\nFidelity takes precedence over tone and structure: preserve every name, fact, deadline, quantity, condition, question, and expression of uncertainty. Never turn a possibility into a promise or a question into an assertion. Do not invent requirements, constraints, facts, recipients, or commitments. Leave unspecified details unspecified. Improve clarity without changing the speaker\'s meaning.'
}

// A transform may reorganize prose, but the built-in commands may not invent
// or drop factual anchors. Custom commands retain their explicit semantics
// (for example translation or summarization).
export function preserveTransform(commandId: string, raw: string, output: string, dictionary: string[] = []): string {
  if (commandId === 'seed-polish') {
    return decideFormattedText('local-format', raw, output, dictionary).text
  }
  if (commandId !== 'seed-email' && commandId !== 'seed-prompt-engineer') return output
  // Section numbering is layout, not a newly invented quantity.
  const content = output.replace(/^\s*\d+[.)]\s+/gm, '')
  return validateFormattedTranscript(raw, content, dictionary).accepted ? output : raw
}
