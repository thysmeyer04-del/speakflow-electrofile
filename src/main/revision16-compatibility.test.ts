import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const read = (relative: string): string =>
  readFileSync(path.join(process.cwd(), relative), 'utf8')

test('v0.8 desktop binds owner, purge generation, metering, and v2 delivery', () => {
  const controller = read('src/main/recording-controller.ts')
  const dictate = read('src/main/dictate.ts')
  const usage = read('src/main/asr-token.ts')
  const outbox = read('src/main/event-outbox.ts')
  const security = read('src/main/security.ts')
  const ipc = read('src/main/ipc.ts')
  const preload = read('src/preload/preload.ts')

  assert.match(controller, /recordingAuthContext = getAuthContext\(\)/)
  assert.match(controller, /deletionGeneration: stats\.deletionGeneration/)
  assert.match(controller, /source: path === 'local' \? 'local' : 'streaming'/)
  assert.match(controller, /protocolVersion: 2/)
  assert.match(controller, /webContents\.mainFrame\.send/)
  assert.doesNotMatch(controller, /falling back to legacy path/)
  assert.match(dictate, /usageEventId/)
  assert.match(dictate, /REVISION16_CONTRACT\.media\.maxDeclaredWords/)
  assert.match(usage, /source: event\.source \?\? 'streaming'/)
  assert.match(outbox, /safeStorage\.encryptString/)
  assert.match(outbox, /withOwnerLock/)
  assert.match(outbox, /deletionGeneration/)
  assert.match(security, /trustedMainFrameNonce/)
  assert.match(security, /timingSafeEqual/)
  assert.match(ipc, /history:purge-local/)
  assert.match(ipc, /flushStreamingUsageOutbox/)
  assert.match(preload, /security:get-nonce/)
  assert.match(preload, /\{ nonce, payload \}/)
})
