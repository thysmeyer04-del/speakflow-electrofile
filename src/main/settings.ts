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
}

const defaults: AppSettings = {
  hotkey: 'F11',
  microphone: 'default',
  language: 'en',
  launchAtLogin: true,
  showOverlay: true,
  overlayHandleVisible: true,
  dictationSounds: true,
  muteMusicWhenDictating: false,
  enableSmartFormatting: true,
  stripDisfluencies: true,
}

const store = new Store<AppSettings>({
  name: 'speakflow-settings',
  defaults,
  clearInvalidConfig: true,
})

// Migration: 'Control+Meta' (initial broken default) and 'F12' (often
// already held on Windows) are upgraded to F11 so the hotkey registers
// cleanly on first launch.
const LEGACY_HOTKEYS = new Set(['Control+Meta', 'F12'])
const persistedHotkey = store.get('hotkey')
if (typeof persistedHotkey === 'string' && LEGACY_HOTKEYS.has(persistedHotkey)) {
  store.set('hotkey', 'F11')
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
