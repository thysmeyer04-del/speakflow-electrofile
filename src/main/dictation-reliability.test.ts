import test from 'node:test'
import assert from 'node:assert/strict'
import { clipboard } from 'electron'
import { stripFillerWords } from './format-transcript'
import { expandSnippetEntries } from './user-context'
import { preserveTransform } from './transform-preservation'
import { injectText, captureFocusTarget, clearLastOutput, copyLastOutput } from './inject'
import { withClipboard } from './clipboard-transaction'

test('cleanup preserves paragraph breaks', () => {
  assert.equal(stripFillerWords('Hello.\n\nPlease send it.\n- Tomorrow'), 'Hello.\n\nPlease send it.\n- Tomorrow')
  assert.equal(stripFillerWords('Hello. um,\n\nPlease send it.'), 'Hello. \n\nPlease send it.')
})
test('snippets preserve literal dollars, never recurse, and prefer longer triggers', () => {
  const entries = [
    { trigger: 'my address', expansion: 'my signature $& $1 $$' },
    { trigger: 'my signature', expansion: 'Thys' },
    { trigger: 'my address work', expansion: 'Office' },
  ]
  assert.equal(expandSnippetEntries('My address. My address work.', entries), 'my signature $& $1 $$. Office.')
  assert.equal(expandSnippetEntries('émail signature', [{ trigger: 'mail signature', expansion: 'wrong' }]), 'émail signature')
})
test('built-in transforms reject altered facts and negation', () => {
  const raw = 'Do not pay invoice 48219. Email Thys at thys@example.com.'
  for (const id of ['seed-email', 'seed-prompt-engineer', 'seed-polish']) {
    for (const bad of [raw.replace('48219', '48220'), raw.replace('not ', ''), raw.replace('thys@example.com', 'other@example.com')]) {
      assert.equal(preserveTransform(id, raw, bad, ['Thys']), raw)
    }
  }
  assert.equal(preserveTransform('custom-summary', raw, 'Summary'), 'Summary')
})
test('email accepts structure while preserving facts', () => {
  const raw = 'Please pay invoice 48219 tomorrow.'
  const output = 'Subject: Payment request\n\nPlease pay invoice 48219 tomorrow.\n\nThank you.'
  assert.equal(preserveTransform('seed-email', raw, output), output)
})

test('clipboard injection regressions', async (t) => {
  const nut = require('@nut-tree-fork/nut-js')
  let text = 'original'
  let title: string | null = 'Audit editor'
  let presses = 0
  let fail = false
  let userCopy = false
  Object.assign(clipboard, {
    readText: () => text, writeText: (value: string) => { text = value },
    availableFormats: () => text ? ['text/plain'] : [],
    readHTML: () => '', readRTF: () => '',
    readImage: () => ({ isEmpty: () => true }),
    write: (data: { text?: string }) => { text = data.text ?? '' },
    clear: () => { text = '' },
  })
  nut.getActiveWindow = async () => {
    if (!title) throw new Error('no active window')
    return { title, windowHandle: title === 'Audit editor' ? 1 : 2, region: { left: 0, top: 0, width: 800, height: 600 } }
  }
  nut.keyboard.pressKey = async () => {
    presses++
    if (fail) throw new Error('native paste failed')
    if (userCopy) text = 'new user copy'
  }
  const drain = () => withClipboard(async () => {})
  const target = await captureFocusTarget()
  assert.equal(target?.id, 1)
  await t.test('default paste keeps dictated text available for delayed native editors', async () => {
    assert.equal((await injectText('dictation', target)).ok, true)
    await drain()
    assert.equal(text, 'dictation')
    assert.equal(copyLastOutput(), true)
    assert.equal(text, 'dictation')
  })
  await t.test('explicit restoration preserves the previous clipboard', async () => {
    text = 'original'
    await injectText('dictation', target, { restoreClipboard: true })
    await drain()
    assert.equal(text, 'original')
  })
  await t.test('failed paste leaves output available', async () => {
    fail = true
    text = 'original'
    assert.equal((await injectText('recover me', target)).ok, false)
    await drain()
    assert.equal(text, 'recover me')
    fail = false
  })
  await t.test('user clipboard update survives the restore tail', async () => {
    userCopy = true
    await injectText('dictation', target, { restoreClipboard: true })
    await drain()
    assert.equal(text, 'new user copy')
    userCopy = false
  })
  await t.test('unknown focus and changed transform target never receive keystrokes', async () => {
    const before = presses
    title = null
    assert.equal((await injectText('safe', target)).error, 'no-target')
    title = 'Other editor'
    assert.equal((await injectText('safe', target, { requireSameTarget: true })).error, 'focus-changed')
    assert.equal(presses, before)
    title = 'Audit editor'
  })
  await t.test('cancelled queued injection does not modify clipboard or recovery', async () => {
    clearLastOutput()
    text = 'keep'
    const abort = new AbortController()
    abort.abort()
    assert.equal((await injectText('stale', target, { signal: abort.signal })).error, 'cancelled')
    assert.equal(text, 'keep')
    assert.equal(copyLastOutput(), false)
  })
  await t.test('clipboard mutex survives a rejected operation', async () => {
    await assert.rejects(withClipboard(async () => { throw new Error('failure') }))
    assert.equal(await withClipboard(async () => 42), 42)
  })
})
