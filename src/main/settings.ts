import Store from 'electron-store'

export interface AppSettings {
  hotkey: string
  microphone: string
  language: string
  launchAtLogin: boolean
  showOverlay: boolean
  dictationSounds: boolean
  muteMusicWhenDictating: boolean
}

const defaults: AppSettings = {
  hotkey: 'Control+Meta',
  microphone: 'default',
  language: 'auto',
  launchAtLogin: true,
  showOverlay: true,
  dictationSounds: true,
  muteMusicWhenDictating: false,
}

const store = new Store<AppSettings>({
  name: 'speakflow-settings',
  defaults,
  clearInvalidConfig: true,
})

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
