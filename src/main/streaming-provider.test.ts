import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isAsrWsUrlAllowed, validateChoiceSetting } from './security'

test('live provider choices are restricted to Deepgram or off', () => {
  for (const value of ['off', 'deepgram']) {
    assert.deepEqual(validateChoiceSetting('streamingEngine', value), {
      key: 'streamingEngine',
      value,
    })
  }
  for (const value of ['auto', 'openai', 'anything-else']) {
    assert.equal(validateChoiceSetting('streamingEngine', value), null)
  }
})

test('live audio may only reach the exact Deepgram websocket host', () => {
  assert.equal(isAsrWsUrlAllowed('wss://api.deepgram.com/v1/listen'), true)
  assert.equal(isAsrWsUrlAllowed('wss://api.openai.com/v1/realtime'), false)
  assert.equal(isAsrWsUrlAllowed('wss://api.openai.com.attacker.example/v1/realtime'), false)
})

test('recorder capture keeps AGC headroom and emits Deepgram 16 kHz frames', () => {
  const recorder = fs.readFileSync(
    path.join(process.cwd(), 'src', 'recorder', 'recorder.ts'),
    'utf8',
  )
  const worklet = fs.readFileSync(
    path.join(process.cwd(), 'src', 'recorder', 'pcm-worklet.js'),
    'utf8',
  )

  assert.doesNotMatch(recorder, /gain\.gain\.value\s*=\s*1\.4/)
  assert.match(recorder, /AudioContext\(\{ sampleRate: 16_000 \}\)/)
  assert.match(worklet, /FRAME_SAMPLES\s*=\s*800/)
})
