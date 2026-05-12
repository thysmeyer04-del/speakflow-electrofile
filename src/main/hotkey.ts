import { globalShortcut, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { toggleRecording } from './recording-controller'

// Default fallback in case the user's preferred accelerator (e.g. Ctrl+Meta)
// fails to register — modifier-only / OS-reserved combos are unreliable.
const SAFE_FALLBACK = 'Control+Shift+Space'

let currentAccelerator: string | null = null
let lastRegistrationResult: { accelerator: string; ok: boolean; fellBackFrom: string | null } | null = null

export function registerHotkey(preferred: string): boolean {
  // Probe before swapping. Try the preferred accelerator; if it fails, try
  // the safe fallback. Only unregister our previous binding once we have a
  // working new one.
  const tried: Array<{ acc: string; ok: boolean }> = []

  const tryRegister = (acc: string): boolean => {
    if (currentAccelerator === acc) return globalShortcut.isRegistered(acc)
    let ok = false
    try {
      // Don't blow away other unrelated globalShortcut registrations elsewhere
      // in the app: only unregister something if we registered it.
      if (currentAccelerator) {
        try {
          globalShortcut.unregister(currentAccelerator)
        } catch {
          // ignore
        }
      }
      ok = globalShortcut.register(acc, () => {
        void toggleRecording()
      })
    } catch (err) {
      log.error(`Hotkey "${acc}" threw on register:`, err)
      ok = false
    }
    tried.push({ acc, ok })
    if (ok) currentAccelerator = acc
    return ok
  }

  if (tryRegister(preferred)) {
    lastRegistrationResult = { accelerator: preferred, ok: true, fellBackFrom: null }
    log.info(`Hotkey registered: ${preferred}`)
    broadcastHotkeyState()
    return true
  }

  // Preferred failed — try the safe fallback so the user is never left
  // without any hotkey at all.
  if (preferred !== SAFE_FALLBACK && tryRegister(SAFE_FALLBACK)) {
    lastRegistrationResult = {
      accelerator: SAFE_FALLBACK,
      ok: true,
      fellBackFrom: preferred,
    }
    log.warn(
      `Hotkey "${preferred}" unavailable — using fallback "${SAFE_FALLBACK}"`,
    )
    broadcastHotkeyState()
    return true
  }

  log.error(`Could not register any hotkey. Tried: ${tried.map((t) => t.acc).join(', ')}`)
  lastRegistrationResult = {
    accelerator: preferred,
    ok: false,
    fellBackFrom: null,
  }
  currentAccelerator = null
  broadcastHotkeyState()
  return false
}

export function unregisterHotkey(): void {
  if (currentAccelerator) {
    try {
      globalShortcut.unregister(currentAccelerator)
    } catch {
      // ignore
    }
    currentAccelerator = null
  }
}

export function updateHotkey(newAccelerator: string): boolean {
  return registerHotkey(newAccelerator)
}

export function getActiveHotkey(): string | null {
  return currentAccelerator
}

export function getLastRegistrationResult() {
  return lastRegistrationResult
}

function broadcastHotkeyState(): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send('hotkey-state', lastRegistrationResult)
    }
  })
}
