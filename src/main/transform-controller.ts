// Selected text -> transform -> guarded replacement. No selection -> dictation.
import { clipboard, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { getCommand } from './commands-store'
import { transformText } from './transform-llm'
import { getRecordingState, getPendingCommandId, startCommandRecording, stopRecording } from './recording-controller'
import { captureFocusTarget, clearStrayModifiers, injectText, sameTarget, rememberOutput, type WindowSnapshot } from './inject'
import { withClipboard, snapshotClipboard } from './clipboard-transaction'
import { preserveTransform, commandPrompt } from './transform-preservation'
import { getDictionaryWords } from './user-context'

let currentAbort: AbortController | null = null

function broadcast(channel: string, payload?: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

export function runTransform(commandId: string): Promise<void> {
  // Ignore key-repeat; queuing transforms can rewrite the result a second time.
  if (currentAbort) return Promise.resolve()
  const controller = new AbortController()
  currentAbort = controller
  return doRunTransform(commandId, controller.signal).catch((err) => {
    if (!controller.signal.aborted) {
      log.warn('[transform] failed', err)
      broadcast('transcription-error', err instanceof Error ? err.message : 'Transform failed.')
    }
  }).finally(() => {
    if (currentAbort === controller) currentAbort = null
    if (getRecordingState() === 'idle') broadcast('processing-complete')
  })
}

export function handleCommandHotkey(commandId: string): Promise<void> {
  const state = getRecordingState()
  if (state === 'recording' && getPendingCommandId() === commandId) return stopRecording()
  if (state !== 'idle') {
    broadcast('recording-busy', state)
    return Promise.resolve()
  }
  return runTransform(commandId)
}

export function abortInFlightTransform(): void { currentAbort?.abort() }

export async function captureSelection(target: WindowSnapshot, signal: AbortSignal): Promise<string | null> {
  return withClipboard(async () => {
    if (signal.aborted) return null
    const restore = snapshotClipboard()
    const sentinel = `[speakflow:probe:${Date.now()}:${Math.random()}]`
    let ownedText = sentinel
    clipboard.writeText(sentinel)
    try {
      const { keyboard, Key } = require('@nut-tree-fork/nut-js') as typeof import('@nut-tree-fork/nut-js')
      const modifier = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl
      await clearStrayModifiers()
      for (const timeout of [400, 250]) {
        if (signal.aborted) return null
        if (!sameTarget(target, await captureFocusTarget())) throw new Error('Focus changed. Select the text again and retry.')
        try {
          await keyboard.pressKey(modifier, Key.C)
          await sleep(20)
        } finally {
          await keyboard.releaseKey(Key.C, modifier)
        }
        const deadline = Date.now() + timeout
        do {
          if (signal.aborted) return null
          const value = clipboard.readText()
          if (value !== sentinel) {
            ownedText = value
            return value
          }
          await sleep(25)
        } while (Date.now() < deadline)
      }
      return null
    } finally {
      // Restore immediately after capture, not seconds later after the LLM.
      if (clipboard.readText() === ownedText) restore()
    }
  })
}

async function doRunTransform(commandId: string, signal: AbortSignal): Promise<void> {
  if (getRecordingState() !== 'idle') return
  const cmd = getCommand(commandId)
  if (!cmd) return
  const target = await captureFocusTarget()
  if (!target) throw new Error('Select an editable field and try the shortcut again.')
  const selected = await captureSelection(target, signal)
  if (signal.aborted || getRecordingState() !== 'idle') return
  if (!sameTarget(target, await captureFocusTarget())) throw new Error('Focus changed. Select the text again and retry.')
  if (cmd.id === 'seed-voice-edit') {
    if (!selected?.trim()) throw new Error('Select the text you want to edit, then use Voice Edit.')
    await startCommandRecording(cmd.id, { selected, target })
    return
  }
  if (!selected?.trim()) {
    await startCommandRecording(cmd.id)
    return
  }
  broadcast('transform-starting')
  const output = await transformText(commandPrompt(cmd), selected, cmd.model, signal)
  if (signal.aborted || getRecordingState() !== 'idle') return
  const transformed = preserveTransform(cmd.id, selected, output, getDictionaryWords())
  if (transformed !== output) {
    broadcast('transcription-error', 'The rewrite changed protected details. Your original text was kept.')
    return
  }
  // Window identity alone cannot detect a moved caret or edited selection.
  // Re-copy just before replacement and require the original selection.
  if (!sameTarget(target, await captureFocusTarget()) || await captureSelection(target, signal) !== selected) {
    if (!signal.aborted) {
      rememberOutput(transformed)
      broadcast('transcription-error', 'Your selection changed. Use Paste last output from the tray to insert the rewrite where you want it.')
    }
    return
  }
  const result = await injectText(transformed, target, { requireSameTarget: true, signal })
  if (signal.aborted) return
  broadcast('transcription-complete', {
    text: transformed, durationSeconds: 0,
    appName: target.processName, windowTitle: target.title, source: 'transform',
  })
  if (!result.ok) broadcast('transcription-error', 'Automatic replacement stopped. Your result is available with Paste last output or on the clipboard.')
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
