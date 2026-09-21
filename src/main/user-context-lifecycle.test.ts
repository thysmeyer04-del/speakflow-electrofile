import test from 'node:test'
import assert from 'node:assert/strict'
import { refreshUserContext, clearUserContext, getDictionaryWords } from './user-context'

test('late dictionary fetch cannot repopulate signed-out data and refreshes the new owner', async () => {
  const ipc = require('./ipc')
  const transcribe = require('./transcribe')
  let token = 'owner-a-test-token'
  ipc.getAuthToken = () => token
  transcribe.getProxyBaseUrl = () => 'https://fixture.invalid/api'
  const originalFetch = global.fetch
  let resolve!: (response: Response) => void
  global.fetch = async () => new Promise<Response>(r => { resolve = r })
  try {
    const pending = refreshUserContext()
    clearUserContext()
    token = ''
    resolve(Response.json({ dictionary: ['Old owner'] }))
    await pending
    assert.deepEqual(getDictionaryWords(), [])

    token = 'owner-a-test-token'
    const oldRefresh = refreshUserContext()
    clearUserContext()
    token = 'owner-b-test-token'
    global.fetch = async () => Response.json({ dictionary: ['New owner'] })
    // This call collides with the old owner's in-flight request. Its finally
    // must schedule the new owner instead of leaving an empty cache for 5 min.
    await refreshUserContext()
    resolve(Response.json({ dictionary: ['Old owner'] }))
    await oldRefresh
    await new Promise(r => setImmediate(r))
    assert.deepEqual(getDictionaryWords(), ['New owner'])
  } finally {
    global.fetch = originalFetch
    token = ''
    clearUserContext()
  }
})
