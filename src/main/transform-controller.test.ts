import test from 'node:test'
import assert from 'node:assert/strict'
import { clipboard } from 'electron'
import { runTransform, abortInFlightTransform, handleCommandHotkey } from './transform-controller'
import { withClipboard } from './clipboard-transaction'
import { copyLastOutput, clearLastOutput } from './inject'

test('transform lifecycle protects selection, cancellation, and command hotkeys', async (t) => {
  const recorder = require('./recording-controller')
  const llm = require('./transform-llm')
  const nut = require('@nut-tree-fork/nut-js')
  let clip = 'user clipboard'
  let selection = 'Please send invoice 48219.'
  let title = 'Editor'
  let state = 'idle'
  let started = ''
  let pendingCommand = ''
  let stops = 0
  let pastes = 0
  Object.assign(clipboard, {
    readText: () => clip, writeText: (value: string) => { clip = value },
    availableFormats: () => ['text/plain'], readHTML: () => '', readRTF: () => '',
    readImage: () => ({ isEmpty: () => true }),
    write: (data: { text?: string }) => { clip = data.text ?? '' }, clear: () => { clip = '' },
  })
  nut.getActiveWindow = async () => ({ title, windowHandle: title === 'Editor' ? 1 : 2, region: { left: 0, top: 0, width: 800, height: 600 } })
  nut.keyboard.pressKey = async (...keys: string[]) => {
    if (keys.includes('C') && selection) clip = selection
    if (keys.includes('V')) pastes++
  }
  recorder.getRecordingState = () => state
  recorder.getPendingCommandId = () => pendingCommand
  recorder.startCommandRecording = async (id: string) => { started = id }
  recorder.stopRecording = async () => { stops++ }

  await t.test('each default shortcut transforms a selection through one shared paste path', async () => {
    for (const id of ['seed-email', 'seed-prompt-engineer', 'seed-polish']) {
      llm.transformText = async (_prompt: string, input: string) => input
      const before = pastes
      await handleCommandHotkey(id)
      await withClipboard(async () => {})
      assert.equal(pastes, before + 1)
    }
  })
  await t.test('key repeat cannot queue multiple rewrites', async () => {
    let resolve!: (value: string) => void
    let calls = 0
    llm.transformText = () => { calls++; return new Promise<string>(r => { resolve = r }) }
    const first = runTransform('seed-polish')
    await runTransform('seed-polish')
    while (!resolve) await new Promise(r => setTimeout(r, 5))
    resolve(selection)
    await first
    await withClipboard(async () => {})
    assert.equal(calls, 1)
  })
  await t.test('cancellation prevents output even when transport ignores abort', async () => {
    const before = pastes
    llm.transformText = async () => { abortInFlightTransform(); return selection }
    await runTransform('seed-polish')
    assert.equal(pastes, before)
  })
  await t.test('moved selection keeps result recoverable without replacing new text', async () => {
    const before = pastes
    const original = selection
    clearLastOutput()
    llm.transformText = async () => { selection = 'Different selection'; return original }
    await runTransform('seed-polish')
    assert.equal(pastes, before)
    assert.equal(copyLastOutput(), true)
    assert.equal(clip, original)
    selection = original
  })
  await t.test('switched windows never receive a replacement', async () => {
    const before = pastes
    llm.transformText = async () => { title = 'Other window'; return selection }
    await runTransform('seed-polish')
    assert.equal(pastes, before)
    title = 'Editor'
  })
  await t.test('Voice Edit captures selection and starts instruction recording without pasting', async () => {
    const before = pastes
    let context: {selected: string} | undefined
    recorder.startCommandRecording = async (id: string, selected?: {selected: string}) => { started = id; context = selected }
    await handleCommandHotkey('seed-voice-edit')
    assert.equal(started, 'seed-voice-edit')
    assert.equal(context?.selected, selection)
    assert.equal(pastes, before)
  })
  await t.test('no selection starts dictation and matching shortcut stops it', async () => {
    selection = ''
    await handleCommandHotkey('seed-email')
    assert.equal(started, 'seed-email')
    state = 'recording'
    pendingCommand = 'seed-email'
    await handleCommandHotkey('seed-email')
    assert.equal(stops, 1)
    await handleCommandHotkey('seed-polish')
    assert.equal(stops, 1)
    state = 'idle'
  })
})
