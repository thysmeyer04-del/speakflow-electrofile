import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

type Unsubscribe = () => void

let frameNoncePromise: Promise<string> | null = null

async function requestFrameNonce(attempt = 0): Promise<string> {
  try {
    const nonce = await ipcRenderer.invoke('security:get-nonce')
    if (typeof nonce !== 'string' || nonce.length !== 64) throw new Error('invalid-frame-nonce')
    return nonce
  } catch (error) {
    // main installs IPC after the first remote dashboard load; tolerate that
    // narrow startup race without ever sending a privileged unbound message.
    if (attempt >= 9) throw error
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    return requestFrameNonce(attempt + 1)
  }
}

function getFrameNonce(): Promise<string> {
  if (!frameNoncePromise) frameNoncePromise = requestFrameNonce()
  return frameNoncePromise
}

async function privilegedInvoke<T>(channel: string, payload?: unknown): Promise<T> {
  const nonce = await getFrameNonce()
  return ipcRenderer.invoke(channel, { nonce, payload }) as Promise<T>
}

function privilegedSend(channel: string, payload?: unknown): void {
  void getFrameNonce().then((nonce) => ipcRenderer.send(channel, { nonce, payload }))
}

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
  protocolVersion?: 1 | 2
  clientEventId?: string | null
  usageEventId?: string | null
  deletionGeneration?: number
  persisted?: boolean
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
    return privilegedInvoke<SettingsResult>('settings:update-hotkey', v)
  },
  updateMicrophone: async (deviceId: string): Promise<SettingsResult> => {
    const v = safeString(deviceId, 256)
    if (!v) return { ok: false, error: 'invalid-microphone' }
    return privilegedInvoke<SettingsResult>('settings:update-microphone', v)
  },
  updateLanguage: async (language: string): Promise<SettingsResult> => {
    const v = safeString(language, 8)
    if (!v || !ALLOWED_LANGUAGES.has(v.toLowerCase()))
      return { ok: false, error: 'invalid-language' }
    return privilegedInvoke<SettingsResult>('settings:update-language', v.toLowerCase())
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
    return privilegedInvoke<SettingsResult>('settings:update-toggle', { key, value })
  },
  setChoiceSetting: async (key: string, value: string): Promise<SettingsResult> => {
    const allowedValues = ALLOWED_CHOICE_SETTINGS[key]
    if (!allowedValues || !allowedValues.has(value)) {
      return { ok: false, error: 'invalid-choice' }
    }
    return privilegedInvoke<SettingsResult>('settings:set-choice', { key, value })
  },
  getSettings: () => privilegedInvoke('settings:get'),

  // ── App / system info ─────────────────────────────────────────────────────
  getVersion: () => privilegedInvoke('app:version'),
  getPlatform: () => process.platform as NodeJS.Platform,

  // ── Window controls ───────────────────────────────────────────────────────
  minimizeWindow: () => privilegedSend('window:minimize'),
  hideWindow: () => privilegedSend('window:hide'),

  // ── Auth handoff (Supabase JWT for the Railway proxy) ────────────────────
  setAuthToken: async (token: string): Promise<SettingsResult & { expiresAt?: number }> => {
    const v = safeString(token, 4096)
    if (!v) return { ok: false, error: 'invalid-token' }
    return privilegedInvoke<SettingsResult & { expiresAt?: number }>('auth:set-token', v)
  },
  clearAuthToken: () => privilegedSend('auth:clear-token'),
  purgeHistory: (deletionGeneration: number) => {
    if (!Number.isSafeInteger(deletionGeneration) || deletionGeneration < 0) {
      return Promise.resolve({ ok: false, error: 'invalid-generation' })
    }
    return privilegedInvoke<SettingsResult>('history:purge-local', deletionGeneration)
  },

  // ── Recording control ─────────────────────────────────────────────────────
  startRecording: () => privilegedSend('recording:start'),
  stopRecording: () => privilegedSend('recording:stop'),

  // ── Transform Commands ────────────────────────────────────────────────────
  commands: {
    list: () => privilegedInvoke('commands:list'),
    save: (cmd: unknown) => privilegedInvoke('commands:save', cmd),
    delete: (id: string) => {
      const v = safeString(id, 64)
      if (!v) return Promise.resolve({ success: false, error: 'invalid-id' })
      return privilegedInvoke('commands:delete', v)
    },
    resetDefaults: () => privilegedInvoke('commands:reset-defaults'),
    run: (id: string) => {
      const v = safeString(id, 64)
      if (!v) return Promise.resolve({ success: false, error: 'invalid-id' })
      return privilegedInvoke('commands:run', v)
    },
  },
  onTransformStarting: (cb: () => void) => on<void>('transform-starting', cb),

  // ── One-shot Wispr Flow migration ─────────────────────────────────────────
  migrate: {
    fromWispr: () => privilegedInvoke('migrate:start-wispr-import'),
    status: () => privilegedInvoke('migrate:status'),
    onProgress: (cb: (p: unknown) => void) => on<unknown>('migrate:progress', cb),
  },
})
