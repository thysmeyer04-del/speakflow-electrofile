import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

type Unsubscribe = () => void

function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const wrapped = (_event: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

// Defence-in-depth: validate at the preload boundary too so obviously bad
// inputs never even reach main. Main re-validates everything.

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

type SettingsResult = { ok: boolean; error?: string }

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

  // ── Settings (invoke = main returns ok/error) ────────────────────────────
  updateHotkey: async (hotkey: string): Promise<SettingsResult> => {
    const v = safeString(hotkey, 64)
    if (!v || !HOTKEY_PATTERN.test(v)) return { ok: false, error: 'invalid-hotkey' }
    return ipcRenderer.invoke('settings:update-hotkey', v) as Promise<SettingsResult>
  },
  updateMicrophone: async (deviceId: string): Promise<SettingsResult> => {
    const v = safeString(deviceId, 256)
    if (!v) return { ok: false, error: 'invalid-microphone' }
    return ipcRenderer.invoke('settings:update-microphone', v) as Promise<SettingsResult>
  },
  updateLanguage: async (language: string): Promise<SettingsResult> => {
    const v = safeString(language, 8)
    if (!v || !ALLOWED_LANGUAGES.has(v.toLowerCase()))
      return { ok: false, error: 'invalid-language' }
    return ipcRenderer.invoke('settings:update-language', v.toLowerCase()) as Promise<SettingsResult>
  },
  updateToggle: async (
    key: 'showOverlay' | 'dictationSounds' | 'launchAtLogin',
    value: boolean,
  ): Promise<SettingsResult> => {
    const allowed = new Set(['showOverlay', 'dictationSounds', 'launchAtLogin'])
    if (!allowed.has(key)) return { ok: false, error: 'invalid-key' }
    if (typeof value !== 'boolean') return { ok: false, error: 'invalid-value' }
    return ipcRenderer.invoke('settings:update-toggle', { key, value }) as Promise<SettingsResult>
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),

  // ── App / system info ─────────────────────────────────────────────────────
  getVersion: () => ipcRenderer.invoke('app:version'),
  getPlatform: () => process.platform as NodeJS.Platform,

  // ── Window controls ───────────────────────────────────────────────────────
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  hideWindow: () => ipcRenderer.send('window:hide'),

  // ── Auth handoff (Supabase JWT for the Railway proxy) ────────────────────
  setAuthToken: async (token: string): Promise<SettingsResult & { expiresAt?: number }> => {
    const v = safeString(token, 4096)
    if (!v) return { ok: false, error: 'invalid-token' }
    return ipcRenderer.invoke('auth:set-token', v) as Promise<SettingsResult & { expiresAt?: number }>
  },
  clearAuthToken: () => ipcRenderer.send('auth:clear-token'),

  // ── Recording control ─────────────────────────────────────────────────────
  startRecording: () => ipcRenderer.send('recording:start'),
  stopRecording: () => ipcRenderer.send('recording:stop'),
})
