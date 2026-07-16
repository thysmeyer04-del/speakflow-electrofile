import Store from 'electron-store'

export interface AppSettings {
  hotkey: string
  microphone: string
  language: string
  launchAtLogin: boolean
  showOverlay: boolean
  overlayHandleVisible: boolean
  dictationSounds: boolean
  muteMusicWhenDictating: boolean
  enableSmartFormatting: boolean
  stripDisfluencies: boolean
  // 'cloud'  — Groq Whisper API (default; needs internet)
  // 'local'  — on-device Whisper via @xenova/transformers (works offline;
  //            falls back to cloud if the local pass fails)
  transcriptionMode: 'cloud' | 'local'
  // Cloud STT engine. 'groq' = Whisper (default), 'deepgram' = Nova-3.
  // Deepgram failures always fall back to Groq transparently.
  transcriptionProvider: 'groq' | 'deepgram'
  // HuggingFace model id for local mode. Whisper sizes trade speed for
  // accuracy: Xenova/whisper-tiny < base < small < medium.
  localWhisperModel: string
  // NOTE: streamingTranscription was removed with the segment-on-pause
  // streaming feature (Fast Batch, 2026-07). Old deployed dashboards still
  // send the toggle over IPC — ipc.ts accepts it as a no-op. Any stale
  // persisted value in electron-store is simply ignored.
}

const defaults: AppSettings = {
  hotkey: 'Control+Shift+Space',
  microphone: 'default',
  language: 'en',
  launchAtLogin: true,
  showOverlay: true,
  overlayHandleVisible: true,
  dictationSounds: true,
  muteMusicWhenDictating: false,
  enableSmartFormatting: true,
  stripDisfluencies: true,
  transcriptionMode: 'cloud',
  transcriptionProvider: 'groq',
  localWhisperModel: 'Xenova/whisper-medium',
}

const store = new Store<AppSettings>({
  name: 'speakflow-settings',
  defaults,
  clearInvalidConfig: true,
})

// The proven-reliable default. Control+Shift+Space registers cleanly via
// Electron's globalShortcut and doesn't collide with OS fullscreen/maximize.
const NEW_DEFAULT = 'Control+Shift+Space'

// Migration: 'Control+Meta' (initial broken default) and 'F12' (often already
// held on Windows) never registered reliably — upgrade to NEW_DEFAULT.
const LEGACY_HOTKEYS = new Set(['Control+Meta', 'F12'])
const persistedHotkey = store.get('hotkey')
if (typeof persistedHotkey === 'string' && LEGACY_HOTKEYS.has(persistedHotkey)) {
  store.set('hotkey', NEW_DEFAULT)
}

// One-shot migration off the old F11 default. F11 collides with OS fullscreen
// and registers unreliably as a global shortcut, so move existing F11 users to
// NEW_DEFAULT — but only ONCE (guarded by a marker), so anyone who later
// deliberately re-selects F11 in settings keeps it.
const F11_MIGRATION_KEY = 'migratedF11Default' as const
const flexStore = store as unknown as {
  get(key: string): unknown
  set(key: string, value: unknown): void
}
if (!flexStore.get(F11_MIGRATION_KEY)) {
  if (store.get('hotkey') === 'F11') {
    store.set('hotkey', NEW_DEFAULT)
  }
  flexStore.set(F11_MIGRATION_KEY, true)
}

export function getSettings(): AppSettings {
  return { ...defaults, ...(store.store as Partial<AppSettings>) }
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return store.get(key, defaults[key]) as AppSettings[K]
}

export function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): void {
  store.set(key, value)
}
