import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

type Unsubscribe = () => void

function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const wrapped = (_event: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const ALLOWED_LANGUAGES = new Set([
  'auto', 'en', 'af', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru',
  'ja', 'ko', 'zh', 'ar', 'hi', 'tr', 'sv', 'da', 'no', 'fi',
])

const HOTKEY_PATTERN =
  /^((Control|Ctrl|Alt|Option|Shift|Cmd|Command|Meta|Super)\+){0,3}(F\d{1,2}|[A-Z0-9]|Space|Tab|Backspace|Delete|Return|Enter|Escape|Up|Down|Left|Right|Home|End|PageUp|PageDown)$/i

function safeString(input: unknown, maxLength: number): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return null
  return trimmed
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Recording state listeners (main → renderer) ────────────────────────────
  onRecordingStarted: (cb: () => void) => on<void>('recording-started', cb),
  onRecordingStopped: (cb: () => void) => on<void>('recording-stopped', cb),
  onProcessingStarted: (cb: () => void) => on<void>('processing-started', cb),
  onProcessingComplete: (cb: () => void) => on<void>('processing-complete', cb),
  onTranscriptionComplete: (cb: (text: string) => void) =>
    on<string>('transcription-complete', cb),
  onTranscriptionError: (cb: (message: string) => void) =>
    on<string>('transcription-error', cb),
  onNavigateTo: (cb: (route: string) => void) => on<string>('navigate-to', cb),
  onUpdateAvailable: (cb: (version: string) => void) =>
    on<string>('update-available', cb),

  // ── Settings (renderer → main, with validation at the boundary) ───────────
  updateHotkey: (hotkey: string) => {
    const v = safeString(hotkey, 64)
    if (!v || !HOTKEY_PATTERN.test(v)) return false
    ipcRenderer.send('settings:update-hotkey', v)
    return true
  },
  updateMicrophone: (deviceId: string) => {
    const v = safeString(deviceId, 256)
    if (!v) return false
    ipcRenderer.send('settings:update-microphone', v)
    return true
  },
  updateLanguage: (language: string) => {
    const v = safeString(language, 8)
    if (!v || !ALLOWED_LANGUAGES.has(v.toLowerCase())) return false
    ipcRenderer.send('settings:update-language', v.toLowerCase())
    return true
  },
  updateToggle: (key: 'showOverlay' | 'dictationSounds' | 'launchAtLogin', value: boolean) => {
    const allowed = new Set(['showOverlay', 'dictationSounds', 'launchAtLogin'])
    if (!allowed.has(key)) return false
    if (typeof value !== 'boolean') return false
    ipcRenderer.send('settings:update-toggle', { key, value })
    return true
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),

  // ── App / system info (read-only) ─────────────────────────────────────────
  getVersion: () => ipcRenderer.invoke('app:version'),
  getPlatform: () => process.platform as NodeJS.Platform,

  // ── Window controls ───────────────────────────────────────────────────────
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  hideWindow: () => ipcRenderer.send('window:hide'),

  // ── Auth handoff: dashboard tells main process the current Supabase JWT ──
  // (used only for calling the Railway proxy in prod)
  setAuthToken: (token: string) => {
    const v = safeString(token, 4096)
    if (!v) return false
    ipcRenderer.send('auth:set-token', v)
    return true
  },
  clearAuthToken: () => ipcRenderer.send('auth:clear-token'),

  // ── Recording control (manual trigger from dashboard) ────────────────────
  startRecording: () => ipcRenderer.send('recording:start'),
  stopRecording: () => ipcRenderer.send('recording:stop'),
})
