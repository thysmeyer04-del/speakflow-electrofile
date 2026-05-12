import { ipcMain, app, BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import { getSettings, setSetting } from './settings'
import { updateHotkey, getLastRegistrationResult } from './hotkey'
import {
  startRecording,
  stopRecording,
  onRecordingStateChange,
} from './recording-controller'
import {
  assertTrustedSender,
  validateHotkey,
  validateMicrophoneId,
  validateLanguage,
  validateToggleKey,
  validateAuthToken,
} from './security'

interface SetupArgs {
  mainWindow: BrowserWindow
  overlayWindow: BrowserWindow
  onRecordingStateChange?: (recording: boolean) => void
}

let cachedAuthToken: string | null = null
let cachedTokenExpiresAt = 0

export function getAuthToken(): string | null {
  if (!cachedAuthToken) return null
  if (cachedTokenExpiresAt && Date.now() > cachedTokenExpiresAt) {
    cachedAuthToken = null
    cachedTokenExpiresAt = 0
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
      return { ok: true, expiresAt: result.expiresAt ?? 0 }
    },
  )
  gatedOn('auth:clear-token', () => clearAuthTokenCache())

  gatedOn('recording:start', () => {
    startRecording().catch((err) => log.error('startRecording IPC failed', err))
  })
  gatedOn('recording:stop', () => {
    stopRecording().catch((err) => log.error('stopRecording IPC failed', err))
  })

  onRecordingStateChange((s) => {
    const settings = getSettings()
    if (!overlayWindow.isDestroyed()) {
      if (settings.showOverlay && (s === 'starting' || s === 'recording' || s === 'stopping' || s === 'processing')) {
        overlayWindow.showInactive()
      } else {
        overlayWindow.hide()
      }
    }
    trayCallback?.(s === 'recording')
  })
}
