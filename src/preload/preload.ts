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

// Rich transcription-complete payload (older dashboards may still receive a
// plain string from other builds — the renderer handles both shapes).
interface TranscriptionPayload {
  text: string
  durationSeconds: number
  appName: string | null
  windowTitle: string | null
  source: 'dictation' | 'transform'
}

// Choice settings the dashboard may change — mirrors main's allowlist in
// security.ts (defence in depth; main re-validates).
const ALLOWED_CHOICE_SETTINGS: Record<string, Set<string>> = {
  transcriptionMode: new Set(['cloud', 'local']),
  transcriptionProvider: new Set(['groq', 'deepgram']),
  // True Streaming engine (2026-07): opt-in live transcription.
  streamingEngine: new Set(['off', 'deepgram']),
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Recording state listeners (main → renderer) ────────────────────────────
  onRecordingStarted: (cb: () => void) => on<void>('recording-started', cb),
  onRecordingStopped: (cb: () => void) => on<void>('recording-stopped', cb),
  onProcessingStarted: (cb: () => void) => on<void>('processing-started', cb),
  onProcessingComplete: (cb: () => void) => on<void>('processing-complete', cb),
  onTranscriptionComplete: (cb: (payload: string | TranscriptionPayload) => void) =>
    on<string | TranscriptionPayload>('transcription-complete', cb),
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
    key:
      | 'showOverlay'
      | 'overlayHandleVisible'
      | 'dictationSounds'
      | 'launchAtLogin'
      | 'enableSmartFormatting'
      | 'stripDisfluencies'
      | 'asrShadowCompare'
      | 'streamingTranscription',
    value: boolean,
  ): Promise<SettingsResult> => {
    const allowed = new Set([
      'showOverlay',
      'overlayHandleVisible',
      'dictationSounds',
      'launchAtLogin',
      'enableSmartFormatting',
      'stripDisfluencies',
      'asrShadowCompare',
      'streamingTranscription',
    ])
    if (!allowed.has(key)) return { ok: false, error: 'invalid-key' }
    if (typeof value !== 'boolean') return { ok: false, error: 'invalid-value' }
    return ipcRenderer.invoke('settings:update-toggle', { key, value }) as Promise<SettingsResult>
  },
  setChoiceSetting: async (key: string, value: string): Promise<SettingsResult> => {
    const allowedValues = ALLOWED_CHOICE_SETTINGS[key]
    if (!allowedValues || !allowedValues.has(value)) {
      return { ok: false, error: 'invalid-choice' }
    }
    return ipcRenderer.invoke('settings:set-choice', { key, value }) as Promise<SettingsResult>
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

  // ── Transform Commands ────────────────────────────────────────────────────
  commands: {
    list: () => ipcRenderer.invoke('commands:list'),
    save: (cmd: unknown) => ipcRenderer.invoke('commands:save', cmd),
    delete: (id: string) => {
      const v = safeString(id, 64)
      if (!v) return Promise.resolve({ success: false, error: 'invalid-id' })
      return ipcRenderer.invoke('commands:delete', v)
    },
    resetDefaults: () => ipcRenderer.invoke('commands:reset-defaults'),
    run: (id: string) => {
      const v = safeString(id, 64)
      if (!v) return Promise.resolve({ success: false, error: 'invalid-id' })
      return ipcRenderer.invoke('commands:run', v)
    },
  },
  onTransformStarting: (cb: () => void) => on<void>('transform-starting', cb),

  // ── One-shot Wispr Flow migration ─────────────────────────────────────────
  migrate: {
    fromWispr: () => ipcRenderer.invoke('migrate:start-wispr-import'),
    status: () => ipcRenderer.invoke('migrate:status'),
    onProgress: (cb: (p: unknown) => void) => on<unknown>('migrate:progress', cb),
  },
})
