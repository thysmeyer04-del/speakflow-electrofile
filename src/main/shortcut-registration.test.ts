import test from 'node:test'
import assert from 'node:assert/strict'
import { globalShortcut } from 'electron'
import { registerCommandHotkeys, unregisterAllCommandHotkeys, getRegisteredCommandHotkeys, reassertCommandHotkeys } from './commands-hotkey'
import type { Command } from './commands-store'

test('blocked shortcut edits preserve the previous working key, then reclaim the desired key', () => {
  const active = new Set<string>()
  let blocked = 'Ctrl+Shift+4'
  Object.assign(globalShortcut, {
    register: (acc: string) => { if (acc === blocked || active.has(acc)) return false; active.add(acc); return true },
    unregister: (acc: string) => { active.delete(acc) },
    isRegistered: (acc: string) => active.has(acc),
  })
  const email: Command = { id: 'email', name: 'Email', description: '', prompt: 'Edit', hotkeyNumber: 1, order: 0, isSeeded: false }
  assert.equal(registerCommandHotkeys([email])[0].ok, true)
  const edit = { ...email, hotkeyNumber: 4 }
  assert.equal(registerCommandHotkeys([edit])[0].ok, false)
  assert.equal(getRegisteredCommandHotkeys().email, 'Ctrl+Shift+1')
  assert.ok(active.has('Ctrl+Shift+1'))
  blocked = ''
  reassertCommandHotkeys()
  assert.equal(getRegisteredCommandHotkeys().email, 'Ctrl+Shift+4')
  assert.ok(!active.has('Ctrl+Shift+1'))
  unregisterAllCommandHotkeys()
  assert.equal(active.size, 0)
})
