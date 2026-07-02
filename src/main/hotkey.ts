import { globalShortcut, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { toggleRecording } from './recording-controller'

// Default fallback in case the user's preferred accelerator (e.g. Ctrl+Meta)
// fails to register — modifier-only / OS-reserved combos are unreliable.
const SAFE_FALLBACK = 'Control+Shift+Space'

let currentAccelerator: string | null = null
// The accelerator the user actually wants (e.g. F11). The watchdog keeps
// trying to (re)claim THIS even if we're temporarily parked on the fallback.
let preferredAccelerator: string | null = null
let watchdogTimer: NodeJS.Timeout | null = null
// How often the watchdog re-attempts to claim the preferred accelerator while
// we're stuck on the fallback (or have nothing). 3 s is responsive without
// hammering the OS.
const WATCHDOG_INTERVAL_MS = 3_000
let lastRegistrationResult: {
  accelerator: string
  ok: boolean
  fellBackFrom: string | null
} | null = null

/**
 * Probe-before-swap: register the candidate FIRST, and only unregister the
 * previously active accelerator after the new one is confirmed. If both
 * preferred and fallback fail, the previously working hotkey is preserved.
 *
 * Also remembers the preferred accelerator and starts a watchdog so that, if
 * we had to park on the fallback (or another app momentarily held the key),
 * we keep trying to reclaim the preferred one instead of silently giving up.
 */
export function registerHotkey(preferred: string): boolean {
  preferredAccelerator = preferred
  startWatchdog()
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
    let previousReleased = false
    try {
      globalShortcut.unregister(previous)
      // Verify it actually went away. If not, we'd have a duplicate active
      // hotkey — roll back to leave the user on a known-good state.
      previousReleased = !safeIsRegistered(previous)
    } catch (err) {
      log.warn(`Failed to unregister previous hotkey ${previous}`, err)
    }
    if (!previousReleased) {
      log.error(
        `Rolling back registration of ${result} — could not release ${previous}`,
      )
      try {
        globalShortcut.unregister(result)
      } catch {
        // ignore — best effort
      }
      lastRegistrationResult = { accelerator: preferred, ok: false, fellBackFrom: null }
      broadcastHotkeyState()
      return false
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

function safeIsRegistered(acc: string): boolean {
  try {
    return globalShortcut.isRegistered(acc)
  } catch {
    return false
  }
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
      log.info(`[timing] hotkey fired at ${Date.now()}`)
      void toggleRecording()
    })
    if (!ok) {
      log.warn(`globalShortcut.register("${acc}") returned false — OS or another app likely holds this key`)
    }
    return ok ? acc : null
  } catch (err) {
    log.error(`Hotkey "${acc}" threw on register:`, (err as Error).message)
    return null
  }
}

export function unregisterHotkey(): void {
  stopWatchdog()
  preferredAccelerator = null
  if (currentAccelerator) {
    try {
      globalShortcut.unregister(currentAccelerator)
    } catch {
      // ignore
    }
    currentAccelerator = null
  }
}

/**
 * Watchdog: while the active hotkey isn't the preferred one (we're parked on
 * the fallback, or have nothing), keep retrying the preferred accelerator so
 * we reclaim it the instant the conflicting app releases it. Also catches the
 * case where the OS silently drops our registration (sleep/wake, fast user
 * switch) — if the active accelerator is no longer actually registered, we
 * re-register it.
 */
function startWatchdog(): void {
  if (watchdogTimer) return
  watchdogTimer = setInterval(() => {
    if (!preferredAccelerator) return

    // Already on the preferred key AND it's still actually held — nothing to do.
    if (currentAccelerator === preferredAccelerator && safeIsRegistered(preferredAccelerator)) {
      return
    }

    // Either we're on the fallback, or our registration got dropped. Re-run the
    // full probe-and-swap against the preferred accelerator.
    log.info(`[hotkey] watchdog reclaiming preferred "${preferredAccelerator}" (active=${currentAccelerator})`)
    reclaimPreferred()
  }, WATCHDOG_INTERVAL_MS)
  // Don't keep the event loop alive just for the watchdog.
  watchdogTimer.unref?.()
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

/** Re-run registration of the preferred accelerator (used by the watchdog and
 *  by reassertHotkey on focus/resume). Reuses the same probe-before-swap path. */
function reclaimPreferred(): void {
  if (!preferredAccelerator) return
  const result = tryRegisterCandidate(preferredAccelerator)
  if (!result) return // still held by something else; try again next tick

  const previous = currentAccelerator
  currentAccelerator = result
  if (previous && previous !== result) {
    try {
      globalShortcut.unregister(previous)
    } catch {
      // best effort — the new key is already active
    }
  }
  lastRegistrationResult = { accelerator: result, ok: true, fellBackFrom: null }
  log.info(`[hotkey] reclaimed preferred hotkey: ${result}`)
  broadcastHotkeyState()
}

/**
 * Re-assert the hotkey after events that can quietly invalidate a global
 * shortcut on Windows (window focus changes, power resume, fast user switch).
 * Cheap to call often — it no-ops when the preferred key is already held.
 */
export function reassertHotkey(): void {
  if (!preferredAccelerator) return
  if (currentAccelerator === preferredAccelerator && safeIsRegistered(preferredAccelerator)) {
    return
  }
  reclaimPreferred()
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
