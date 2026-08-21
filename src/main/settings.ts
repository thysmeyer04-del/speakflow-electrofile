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
  // 'cloud'  — admitted Deepgram Nova-3 API (default; needs internet)
  // 'local'  — on-device Whisper via @huggingface/transformers (works offline;
  //            falls back to cloud if the local pass fails)
  transcriptionMode: 'cloud' | 'local'
  // Cloud STT engine. Deepgram is canonical; the retained 'groq' value is a
  // v0.7.5 compatibility input and is migrated to Deepgram below.
  transcriptionProvider: 'groq' | 'deepgram'
  // HuggingFace model id for local mode. Whisper sizes trade speed for
  // accuracy: Xenova/whisper-tiny < base < small < medium.
  localWhisperModel: string
  // Deepgram Nova-3 live transcription. Every failure falls back to the full
  // recorded clip, so streaming cannot lose a dictation. English/cloud only.
  streamingEngine: 'off' | 'deepgram'
  // Legacy diagnostics toggle. v0.8 never duplicates an admitted request,
  // because doing so could create an unnecessary ASR charge.
  asrShadowCompare: boolean
  // Flowcast Windows beta. Off until the user explicitly accepts screen/audio
  // capture and cloud-upload behavior in Settings.
  flowcastEnabled: boolean
  flowcastCaptureMic: boolean
  flowcastCaptureSystemAudio: boolean
  flowcastCursor: boolean
  flowcastClickHighlight: boolean
  flowcastCameraEnabled: boolean
  flowcastCameraSize: 'small' | 'medium' | 'large'
  // Normalized center point inside the selected capture target.
  flowcastCameraX: number
  flowcastCameraY: number
  flowcastQuality: 'balanced' | 'high'
  flowcastVisibility: 'private' | 'unlisted'
  // Local is the active product path and never contacts the Flowcast API.
  // Cloud remains dormant behind the production profile/server gates.
  flowcastStorageMode: 'local' | 'cloud'
  // Empty means Flowcast has not been activated on this computer yet. The
  // user must choose a folder before the enabled setting can become true.
  flowcastExportDirectory: string
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
  transcriptionProvider: 'deepgram',
  localWhisperModel: 'Xenova/whisper-medium',
  streamingEngine: 'deepgram',
  asrShadowCompare: false,
  flowcastEnabled: false,
  flowcastCaptureMic: true,
  flowcastCaptureSystemAudio: true,
  flowcastCursor: true,
  flowcastClickHighlight: true,
  flowcastCameraEnabled: false,
  flowcastCameraSize: 'small',
  flowcastCameraX: 0.14,
  flowcastCameraY: 0.82,
  flowcastQuality: 'balanced',
  flowcastVisibility: 'private',
  flowcastStorageMode: 'local',
  flowcastExportDirectory: '',
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

// Revision 18 renames the local destination from the implementation-specific
// "OneDrive" label to what it always was technically: an arbitrary local
// folder. Existing installations keep their selected path.
if (flexStore.get('flowcastStorageMode') !== 'local') {
  store.set('flowcastStorageMode', 'local')
}
if (store.get('flowcastEnabled') && !store.get('flowcastExportDirectory').trim()) {
  store.set('flowcastEnabled', false)
}

// Product migration: Deepgram is the canonical speech-to-text provider.
// Run once so installations that inherited the earlier Groq batch default or
// the short-lived OpenAI/auto experiment move to the same Deepgram path. A
// user can still turn live transcription off again after this migration.
const DEEPGRAM_PRIMARY_MIGRATION_KEY = 'migratedDeepgramPrimaryV1' as const
if (!flexStore.get(DEEPGRAM_PRIMARY_MIGRATION_KEY)) {
  store.set('transcriptionProvider', 'deepgram')
  store.set('streamingEngine', 'deepgram')
  flexStore.set(DEEPGRAM_PRIMARY_MIGRATION_KEY, true)
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
