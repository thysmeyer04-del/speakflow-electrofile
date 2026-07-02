// globalShortcut registration for Transform Commands.
//
// Each command has hotkeyNumber 1..9 → registers "Ctrl+Shift+N" on
// Windows/Linux and "Cmd+Shift+N" on macOS. Uses probe-before-swap so a
// failed registration (number held by another app — most likely Wispr Flow
// during migration) leaves previously-registered hotkeys intact and surfaces
// the failure for the UI.

import { globalShortcut } from 'electron'
import log from 'electron-log/main'
import type { Command } from './commands-store'
import { handleCommandHotkey } from './transform-controller'

const registered = new Map<string, string>() // commandId → accelerator

function accelFor(n: number): string {
  return process.platform === 'darwin' ? `Cmd+Shift+${n}` : `Ctrl+Shift+${n}`
}

export interface HotkeyRegistrationResult {
  commandId: string
  accelerator: string
  ok: boolean
  error?: string
}

export function registerCommandHotkeys(
  commands: Command[],
): HotkeyRegistrationResult[] {
  // Always unregister first — clears any stale bindings.
  unregisterAllCommandHotkeys()

  const results: HotkeyRegistrationResult[] = []
  for (const cmd of commands) {
    const acc = accelFor(cmd.hotkeyNumber)
    let alreadyRegistered = false
    try {
      alreadyRegistered = globalShortcut.isRegistered(acc)
    } catch (err) {
      log.warn(`[commands-hotkey] "${acc}" not a valid accelerator`, err)
      results.push({ commandId: cmd.id, accelerator: acc, ok: false, error: 'invalid-accelerator' })
      continue
    }
    if (alreadyRegistered) {
      log.warn(`[commands-hotkey] ${acc} already held by another app — skipping`)
      results.push({
        commandId: cmd.id,
        accelerator: acc,
        ok: false,
        error: 'already-registered',
      })
      continue
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
        results.push({
          commandId: cmd.id,
          accelerator: acc,
          ok: false,
          error: 'register-returned-false',
        })
        continue
      }
      registered.set(cmd.id, acc)
      results.push({ commandId: cmd.id, accelerator: acc, ok: true })
      log.info(`[commands-hotkey] registered ${acc} → ${cmd.name}`)
    } catch (err) {
      log.error(`[commands-hotkey] register("${acc}") threw`, err)
      results.push({
        commandId: cmd.id,
        accelerator: acc,
        ok: false,
        error: 'register-threw',
      })
    }
  }
  return results
}

export function unregisterAllCommandHotkeys(): void {
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
