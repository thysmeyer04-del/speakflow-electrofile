import { globalShortcut } from 'electron'
import log from 'electron-log/main'
import { toggleRecording } from './audio'

let currentAccelerator: string | null = null

export function registerHotkey(accelerator: string): boolean {
  unregisterHotkey()

  try {
    const ok = globalShortcut.register(accelerator, () => {
      toggleRecording()
    })

    if (!ok) {
      log.error(`Hotkey "${accelerator}" registration failed (already in use?).`)
      return false
    }

    currentAccelerator = accelerator
    log.info(`Hotkey registered: ${accelerator}`)
    return true
  } catch (err) {
    log.error(`Hotkey registration threw for "${accelerator}":`, err)
    return false
  }
}

export function unregisterHotkey(): void {
  if (currentAccelerator) {
    try {
      globalShortcut.unregister(currentAccelerator)
    } catch {
      // ignore
    }
  }
  globalShortcut.unregisterAll()
  currentAccelerator = null
}

export function updateHotkey(newAccelerator: string): boolean {
  return registerHotkey(newAccelerator)
}
