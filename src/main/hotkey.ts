import { globalShortcut, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { toggleRecording } from './recording-controller'

// Default fallback in case the user's preferred accelerator (e.g. Ctrl+Meta)
// fails to register — modifier-only / OS-reserved combos are unreliable.
const SAFE_FALLBACK = 'Control+Shift+Space'

let currentAccelerator: string | null = null
let lastRegistrationResult: {
  accelerator: string
  ok: boolean
  fellBackFrom: string | null
} | null = null

/**
 * Probe-before-swap: register the candidate FIRST, and only unregister the
 * previously active accelerator after the new one is confirmed. If both
 * preferred and fallback fail, the previously working hotkey is preserved.
 */
export function registerHotkey(preferred: string): boolean {
  const result = tryRegisterCandidate(preferred)
    ?? (preferred !== SAFE_FALLBACK ? tryRegisterCandidate(SAFE_FALLBACK) : null)

  if (!result) {
    log.error(`Could not register any hotkey. Keeping previous: ${currentAccelerator}`)
    lastRegistrationResult = {
      accelerator: preferred,
      ok: false,
      fellBackFrom: null,
    }
    broadcastHotkeyState()
    return false
  }

  // New hotkey registered. Now safe to release the old one (if different).
  const previous = currentAccelerator
  if (previous && previous !== result) {
    try {
      globalShortcut.unregister(previous)
    } catch (err) {
      log.warn(`Failed to unregister previous hotkey ${previous}`, err)
    }
  }

  currentAccelerator = result
  lastRegistrationResult = {
    accelerator: result,
    ok: true,
    fellBackFrom: result !== preferred ? preferred : null,
  }
  log.info(`Hotkey registered: ${result}${result !== preferred ? ` (fell back from ${preferred})` : ''}`)
  broadcastHotkeyState()
  return true
}

/** Attempt to register a candidate without touching `currentAccelerator`. Returns the accelerator on success. */
function tryRegisterCandidate(acc: string): string | null {
  // isRegistered() itself throws on invalid accelerators (e.g. "Control+Meta"
  // isn't accepted on Electron). Treat any throw as "candidate not viable".
  let alreadyRegistered = false
  try {
    alreadyRegistered = globalShortcut.isRegistered(acc)
  } catch (err) {
    log.warn(`Hotkey "${acc}" not a valid accelerator:`, (err as Error).message)
    return null
  }

  if (alreadyRegistered) {
    if (acc === currentAccelerator) return acc // already ours
    log.warn(`Hotkey "${acc}" already registered by another app`)
    return null
  }

  try {
    const ok = globalShortcut.register(acc, () => {
      void toggleRecording()
    })
    return ok ? acc : null
  } catch (err) {
    log.error(`Hotkey "${acc}" threw on register:`, (err as Error).message)
    return null
  }
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
