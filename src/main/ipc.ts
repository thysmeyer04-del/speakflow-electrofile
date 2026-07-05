import { ipcMain, app, BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { getSettings, setSetting } from './settings'
import { updateHotkey, getLastRegistrationResult } from './hotkey'
import {
  startRecording,
  stopRecording,
  onRecordingStateChange,
  abortInFlightRecording,
} from './recording-controller'
import {
  getCommands,
  saveCommand,
  deleteCommand,
  resetToDefaults,
  type Command,
} from './commands-store'
import {
  registerCommandHotkeys,
  getRegisteredCommandHotkeys,
} from './commands-hotkey'
import { runTransform } from './transform-controller'
import { runWisprMigration, isWisprMigrationRunning } from './migrate-wispr'
import {
  assertTrustedSender,
  validateHotkey,
  validateMicrophoneId,
  validateLanguage,
  validateToggleKey,
  validateChoiceSetting,
  validateAuthToken,
} from './security'
import { refreshUserContext, clearUserContext } from './user-context'

interface SetupArgs {
  mainWindow: BrowserWindow
  overlayWindow: BrowserWindow
  onRecordingStateChange?: (recording: boolean) => void
}

let cachedAuthToken: string | null = null
let cachedTokenExpiresAt = 0

// 60s safety margin — refuse tokens about to expire so a long-running call
// (embedding compute + network) doesn't blow up half-way through with 401.
const TOKEN_FRESHNESS_MARGIN_MS = 60_000

export function getAuthToken(): string | null {
  if (!cachedAuthToken) return null
  if (cachedTokenExpiresAt && Date.now() > cachedTokenExpiresAt - TOKEN_FRESHNESS_MARGIN_MS) {
    if (Date.now() > cachedTokenExpiresAt) {
      cachedAuthToken = null
      cachedTokenExpiresAt = 0
    }
    return null
  }
  return cachedAuthToken
}

export function clearAuthTokenCache(): void {
  cachedAuthToken = null
  cachedTokenExpiresAt = 0
}

function gatedOn<T>(channel: string, handler: (event: IpcMainEvent, payload: T) => void) {
  ipcMain.removeAllListeners(channel)
  ipcMain.on(channel, (event, payload) => {
    if (!assertTrustedSender(event, channel)) return
    handler(event, payload as T)
  })
}

function gatedHandle<T, R>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, payload: T) => R | Promise<R>,
) {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (event, payload) => {
    if (!assertTrustedSender(event, channel)) {
      throw new Error('untrusted-sender')
    }
    return await handler(event, payload as T)
  })
}

export function setupIPC({ mainWindow, overlayWindow, onRecordingStateChange: trayCallback }: SetupArgs): void {
  gatedHandle('app:version', () => app.getVersion())
  gatedHandle('hotkey:get-status', () => getLastRegistrationResult())

  gatedOn('window:minimize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.minimize()
  })
  gatedOn('window:hide', () => {
    if (!mainWindow.isDestroyed()) mainWindow.hide()
  })

  gatedHandle('settings:get', () => getSettings())

  gatedHandle<string, { ok: boolean; error?: string; activeHotkey?: string }>(
    'settings:update-hotkey',
    (_event, raw) => {
      const v = validateHotkey(raw)
      if (!v) return { ok: false, error: 'invalid-hotkey' }
      setSetting('hotkey', v)
      const ok = updateHotkey(v)
      const result = getLastRegistrationResult()
      log.info(`Hotkey requested ${v} → active=${result?.accelerator}`)
      return { ok, activeHotkey: result?.accelerator }
    },
  )

  gatedHandle<string, { ok: boolean; error?: string }>(
    'settings:update-microphone',
    (_event, raw) => {
      const v = validateMicrophoneId(raw)
      if (!v) return { ok: false, error: 'invalid-microphone' }
      setSetting('microphone', v)
      return { ok: true }
    },
  )

  gatedHandle<string, { ok: boolean; error?: string }>(
    'settings:update-language',
    (_event, raw) => {
      const v = validateLanguage(raw)
      if (!v) return { ok: false, error: 'invalid-language' }
      setSetting('language', v)
      return { ok: true }
    },
  )

  gatedHandle<{ key: unknown; value: unknown }, { ok: boolean; error?: string }>(
    'settings:update-toggle',
    (_event, raw) => {
      if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid-payload' }
      const key = validateToggleKey(raw.key)
      const value = raw.value
      if (!key) return { ok: false, error: 'invalid-key' }
      if (typeof value !== 'boolean') return { ok: false, error: 'invalid-value' }
      setSetting(key, value)
      if (key === 'launchAtLogin') {
        try {
          app.setLoginItemSettings({ openAtLogin: value })
        } catch (err) {
          log.warn('Failed to update login item settings', err)
        }
      }
      if (key === 'overlayHandleVisible' && overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay-handle-hidden', !value)
      }
      return { ok: true }
    },
  )

  // String-enum settings (engine controls). Strictly allowlisted in
  // security.ts — only transcriptionMode and transcriptionProvider, and only
  // their known values, ever reach electron-store.
  gatedHandle<{ key: unknown; value: unknown }, { ok: boolean; error?: string }>(
    'settings:set-choice',
    (_event, raw) => {
      if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid-payload' }
      const validated = validateChoiceSetting(raw.key, raw.value)
      if (!validated) return { ok: false, error: 'invalid-choice' }
      // Narrow per key so setSetting gets a correlated key/value pair.
      if (validated.key === 'transcriptionMode') {
        setSetting('transcriptionMode', validated.value)
      } else {
        setSetting('transcriptionProvider', validated.value)
      }
      return { ok: true }
    },
  )

  gatedHandle<string, { ok: boolean; error?: string; expiresAt?: number }>(
    'auth:set-token',
    (_event, raw) => {
      const result = validateAuthToken(raw)
      if (!result.ok) {
        log.warn(`Auth token rejected: ${result.reason}`)
        clearAuthTokenCache()
        return { ok: false, error: result.reason }
      }
      cachedAuthToken = (raw as string).trim()
      cachedTokenExpiresAt = result.expiresAt ?? 0
      // Warm the personal dictionary + snippets cache now that we can make
      // RLS-authorized reads. Fire-and-forget — never blocks the auth reply.
      void refreshUserContext()
      return { ok: true, expiresAt: result.expiresAt ?? 0 }
    },
  )
  gatedOn('auth:clear-token', () => {
    clearAuthTokenCache()
    // Drop the signed-out user's dictionary/snippets so they can't leak
    // into another account's session.
    clearUserContext()
    // Also abort any recording/transcription in flight so a sign-out can't
    // leave a stale request continuing with the just-cleared token.
    abortInFlightRecording('auth-cleared')
  })

  gatedOn('recording:start', () => {
    startRecording().catch((err) => log.error('startRecording IPC failed', err))
  })
  gatedOn('recording:stop', () => {
    stopRecording().catch((err) => log.error('stopRecording IPC failed', err))
  })

  // ── Transform Commands ────────────────────────────────────────────────────
  gatedHandle('commands:list', () => ({
    commands: getCommands(),
    registeredHotkeys: getRegisteredCommandHotkeys(),
  }))
  gatedHandle<Partial<Command>, { success: boolean; error?: string; command?: Command }>(
    'commands:save',
    (_event, raw) => {
      if (!raw || typeof raw !== 'object') return { success: false, error: 'invalid-payload' }
      const result = saveCommand(raw)
      if (result.success) {
        // Re-register all hotkeys to reflect the change.
        registerCommandHotkeys(getCommands())
      }
      return result
    },
  )
  gatedHandle<string, { success: boolean; error?: string }>('commands:delete', (_event, id) => {
    if (typeof id !== 'string' || !id) return { success: false, error: 'invalid-id' }
    deleteCommand(id)
    registerCommandHotkeys(getCommands())
    return { success: true }
  })
  gatedHandle('commands:reset-defaults', () => {
    resetToDefaults()
    registerCommandHotkeys(getCommands())
    return { success: true }
  })
  gatedHandle<string, { success: boolean; error?: string }>('commands:run', async (_event, id) => {
    if (typeof id !== 'string' || !id) return { success: false, error: 'invalid-id' }
    try {
      await runTransform(id)
      return { success: true }
    } catch (err) {
      log.error('commands:run failed', err)
      return { success: false, error: (err as Error).message ?? 'unknown' }
    }
  })

  // ── One-shot migration from Wispr Flow ───────────────────────────────────
  gatedHandle('migrate:start-wispr-import', () => runWisprMigration())
  gatedHandle('migrate:status', () => ({ running: isWisprMigrationRunning() }))

  // Push initial settings and hotkey state once the overlay renderer is ready
  overlayWindow.webContents.on('did-finish-load', () => {
    if (!overlayWindow.isDestroyed()) {
      const visible = getSettings().overlayHandleVisible
      overlayWindow.webContents.send('overlay-handle-hidden', !visible)
      const hotkeyResult = getLastRegistrationResult()
      if (hotkeyResult) {
        overlayWindow.webContents.send('hotkey-state', hotkeyResult)
      }
    }
  })

  onRecordingStateChange((s) => {
    // Overlay window stays shown for the whole app lifetime; visibility is
    // controlled purely by CSS via 'recording-starting' / 'processing-
    // complete' events. We DON'T call show/hide here because the cold-paint
    // cost on first show is what made the overlay feel laggy.
    trayCallback?.(s === 'recording')
  })
}
