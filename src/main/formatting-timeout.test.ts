import test from 'node:test'
import assert from 'node:assert/strict'
import { formatTranscript } from './format-transcript'

test('optional polishing aborts after 2.5 seconds instead of blocking dictation for 30 seconds', async (t) => {
  const llm = require('./transform-llm')
  llm.transformText = (_prompt: string, _text: string, _model: string, signal: AbortSignal) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const result = formatTranscript('Please preserve this complete original dictation.', { stripDisfluencies: true })
  const rejected = assert.rejects(result, /aborted/)
  t.mock.timers.tick(2_500)
  await rejected
})
