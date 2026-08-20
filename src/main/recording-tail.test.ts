import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { STOP_TAIL_CAPTURE_MS, waitForStopTail } from './recording-tail'

test('stop tail gives pending microphone frames time to reach both transcription paths', async () => {
  let requestedDelay = -1

  await waitForStopTail(async (milliseconds) => {
    requestedDelay = milliseconds
  })

  assert.equal(requestedDelay, STOP_TAIL_CAPTURE_MS)
  assert.ok(STOP_TAIL_CAPTURE_MS >= 250)
  assert.ok(STOP_TAIL_CAPTURE_MS <= 500)
})

test('the controller drains the audio tail before finalizing Deepgram', () => {
  const controller = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'recording-controller.ts'),
    'utf8',
  )
  const drain = controller.indexOf('await waitForStopTail()')
  const finalize = controller.indexOf('const streamSession = asrSession', drain)
  const stopRecorder = controller.indexOf('await stopRecorderSession()', drain)

  assert.ok(drain >= 0)
  assert.ok(finalize > drain)
  assert.ok(stopRecorder > drain)
})
