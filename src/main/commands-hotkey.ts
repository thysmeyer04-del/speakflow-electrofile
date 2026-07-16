// globalShortcut registration for Transform Commands.
//
// Each command has hotkeyNumber 1..9 → registers "Ctrl+Shift+N" on
// Windows/Linux and "Cmd+Shift+N" on macOS. Uses probe-before-swap so a
// failed registration (number held by another app — most likely Wispr Flow
// during migration) leaves previously-registered hotkeys intact and surfaces
// the failure for the UI.
//
// Conflicts are NOT permanent: like the dictation hotkey (hotkey.ts), a
// watchdog keeps retrying blocked accelerators so that when the other app
// releases the key we claim it without needing an app restart (2026-07-16:
// Ctrl+Shift+1/2 were held by another app all day and the commands silently
// stayed dead until the next restart). The first failure per accelerator per
// session also raises an OS notification so the user knows WHY the shortcut
// is doing nothing.

import { globalShortcut, Notification } from 'electron'
import log from 'electron-log/main'
import type { Command } from './commands-store'
import { handleCommandHotkey } from './transform-controller'

const registered = new Map<string, string>() // commandId → accelerator

// The full command list we WANT registered — the watchdog retries the ones
// that failed. Refreshed on every registerCommandHotkeys sweep (startup +
// every command CRUD from the dashboard).
let desiredCommands: Command[] = []
let watchdogTimer: NodeJS.Timeout | null = null
const WATCHDOG_INTERVAL_MS = 5_000
// One notification per accelerator per session — a retry loop must not spam.
const notifiedConflicts = new Set<string>()

function accelFor(n: number): string {
  return process.platform === 'darwin' ? `Cmd+Shift+${n}` : `Ctrl+Shift+${n}`
}

function notifyConflictOnce(acc: string, commandName: string): void {
  if (notifiedConflicts.has(acc)) return
  notifiedConflicts.add(acc)
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Speakflow shortcut blocked',
        body: `${acc} (${commandName}) is held by another app. Speakflow will claim it automatically once it's free.`,
        silent: true,
      }).show()
    }
  } catch (err) {
    log.warn('[commands-hotkey] conflict notification failed', err)
  }
}

export interface HotkeyRegistrationResult {
  commandId: string
  accelerator: string
  ok: boolean
  error?: string
}

function tryRegisterCommand(cmd: Command): HotkeyRegistrationResult {
  const acc = accelFor(cmd.hotkeyNumber)
  let alreadyRegistered = false
  try {
    alreadyRegistered = globalShortcut.isRegistered(acc)
  } catch (err) {
    log.warn(`[commands-hotkey] "${acc}" not a valid accelerator`, err)
    return { commandId: cmd.id, accelerator: acc, ok: false, error: 'invalid-accelerator' }
  }
  if (alreadyRegistered) {
    log.warn(`[commands-hotkey] ${acc} already held by another app — skipping`)
    return { commandId: cmd.id, accelerator: acc, ok: false, error: 'already-registered' }
  }
  try {
    const ok = globalShortcut.register(acc, () => {
      log.info(`[commands-hotkey] ${acc} fired → ${cmd.name}`)
      void handleCommandHotkey(cmd.id).catch((err) =>
        log.error('[commands-hotkey] handleCommandHotkey threw', err),
      )
    })
    if (!ok) {
      log.warn(`[commands-hotkey] register("${acc}") returned false`)
      return { commandId: cmd.id, accelerator: acc, ok: false, error: 'register-returned-false' }
    }
    registered.set(cmd.id, acc)
    log.info(`[commands-hotkey] registered ${acc} → ${cmd.name}`)
    return { commandId: cmd.id, accelerator: acc, ok: true }
  } catch (err) {
    log.error(`[commands-hotkey] register("${acc}") threw`, err)
    return { commandId: cmd.id, accelerator: acc, ok: false, error: 'register-threw' }
  }
}

/** Commands we want registered but aren't (invalid accelerators excluded —
 *  retrying those can never succeed). */
function missingCommands(): Command[] {
  return desiredCommands.filter(
    (cmd) => !registered.has(cmd.id) && cmd.hotkeyNumber >= 1 && cmd.hotkeyNumber <= 9,
  )
}

/** One retry pass over blocked accelerators. Quiet: successes log, failures
 *  don't re-warn (the initial sweep already did). Stops the watchdog when
 *  nothing is missing anymore. */
function watchdogTick(): void {
  const missing = missingCommands()
  if (missing.length === 0) {
    stopWatchdog()
    return
  }
  for (const cmd of missing) {
    const acc = accelFor(cmd.hotkeyNumber)
    try {
      if (globalShortcut.isRegistered(acc)) continue // still held elsewhere
      const ok = globalShortcut.register(acc, () => {
        log.info(`[commands-hotkey] ${acc} fired → ${cmd.name}`)
        void handleCommandHotkey(cmd.id).catch((err) =>
          log.error('[commands-hotkey] handleCommandHotkey threw', err),
        )
      })
      if (ok) {
        registered.set(cmd.id, acc)
        log.info(`[commands-hotkey] watchdog reclaimed ${acc} → ${cmd.name}`)
      }
    } catch {
      // Invalid accelerator or transient OS error — next tick retries.
    }
  }
  if (missingCommands().length === 0) stopWatchdog()
}

function startWatchdog(): void {
  if (watchdogTimer) return
  watchdogTimer = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS)
  // Never keep the process alive just to retry hotkeys.
  watchdogTimer.unref()
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

/** Immediate retry of blocked command hotkeys — called on focus/resume next
 *  to reassertHotkey(), because sleep/wake and app switches are exactly when
 *  another app may have released (or silently stolen) the keys. */
export function reassertCommandHotkeys(): void {
  watchdogTick()
  if (missingCommands().length > 0) startWatchdog()
}

export function registerCommandHotkeys(
  commands: Command[],
): HotkeyRegistrationResult[] {
  // Always unregister first — clears any stale bindings.
  unregisterAllCommandHotkeys()
  desiredCommands = commands

  const results = commands.map(tryRegisterCommand)

  // Conflicts get one visible notification and a retry loop; permanent
  // failures (invalid accelerator) get neither.
  for (const r of results) {
    if (!r.ok && r.error !== 'invalid-accelerator') {
      const cmd = commands.find((c) => c.id === r.commandId)
      notifyConflictOnce(r.accelerator, cmd?.name ?? 'Transform command')
    }
  }
  if (missingCommands().length > 0) startWatchdog()
  return results
}

export function unregisterAllCommandHotkeys(): void {
  stopWatchdog()
  for (const acc of registered.values()) {
    try {
      globalShortcut.unregister(acc)
    } catch (err) {
      log.warn(`[commands-hotkey] unregister("${acc}") failed`, err)
    }
  }
  registered.clear()
}

export function getRegisteredCommandHotkeys(): Record<string, string> {
  return Object.fromEntries(registered)
}
