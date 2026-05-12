import { ipcMain, app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { getSettings, setSetting } from './settings'
import { updateHotkey } from './hotkey'
import { startRecording, stopRecording, onStateChange } from './audio'

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
    return null
  }
  return cachedAuthToken
}

export function setupIPC({ mainWindow, overlayWindow, onRecordingStateChange }: SetupArgs): void {
  // ── App info ──────────────────────────────────────────────────────────────
  ipcMain.handle('app:version', () => app.getVersion())

  // ── Window controls ───────────────────────────────────────────────────────
  ipcMain.on('window:minimize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.minimize()
  })
  ipcMain.on('window:hide', () => {
    if (!mainWindow.isDestroyed()) mainWindow.hide()
  })

  // ── Settings ──────────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', () => getSettings())

  ipcMain.on('settings:update-hotkey', (_event, hotkey: string) => {
    setSetting('hotkey', hotkey)
    const ok = updateHotkey(hotkey)
    log.info(`Hotkey updated to ${hotkey} (success=${ok})`)
  })

  ipcMain.on('settings:update-microphone', (_event, deviceId: string) => {
    setSetting('microphone', deviceId)
  })

  ipcMain.on('settings:update-language', (_event, language: string) => {
    setSetting('language', language)
  })

  ipcMain.on('settings:update-toggle', (_event, payload: { key: string; value: boolean }) => {
    const allowed = ['showOverlay', 'dictationSounds', 'launchAtLogin'] as const
    type Allowed = (typeof allowed)[number]
    if (!allowed.includes(payload.key as Allowed)) return
    setSetting(payload.key as Allowed, payload.value)
    if (payload.key === 'launchAtLogin') {
      try {
        app.setLoginItemSettings({ openAtLogin: payload.value })
      } catch (err) {
        log.warn('Failed to update login item settings', err)
      }
    }
  })

  // ── Auth (Supabase JWT handoff for the Railway proxy) ────────────────────
  ipcMain.on('auth:set-token', (_event, token: string) => {
    cachedAuthToken = token
    // JWTs typically last ~1h. Re-check every 50 minutes regardless.
    cachedTokenExpiresAt = Date.now() + 50 * 60 * 1000
  })
  ipcMain.on('auth:clear-token', () => {
    cachedAuthToken = null
    cachedTokenExpiresAt = 0
  })

  // ── Recording control from the dashboard UI ──────────────────────────────
  ipcMain.on('recording:start', () => {
    startRecording().catch((err) => log.error('startRecording IPC failed', err))
  })
  ipcMain.on('recording:stop', () => {
    stopRecording().catch((err) => log.error('stopRecording IPC failed', err))
  })

  // ── Overlay visibility follows the audio state machine ───────────────────
  onStateChange((s) => {
    const settings = getSettings()
    if (!overlayWindow.isDestroyed()) {
      if (settings.showOverlay && (s === 'recording' || s === 'processing')) {
        overlayWindow.showInactive()
      } else {
        overlayWindow.hide()
      }
    }
    onRecordingStateChange?.(s === 'recording')
  })
}
