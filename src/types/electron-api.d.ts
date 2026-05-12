// Type declarations for the contextBridge API exposed to renderer windows.

export {}

declare global {
  interface SpeakflowElectronAPI {
    onRecordingStarted: (cb: () => void) => () => void
    onRecordingStopped: (cb: () => void) => () => void
    onProcessingStarted: (cb: () => void) => () => void
    onProcessingComplete: (cb: () => void) => () => void
    onTranscriptionComplete: (cb: (text: string) => void) => () => void
    onTranscriptionError: (cb: (message: string) => void) => () => void
    onNavigateTo: (cb: (route: string) => void) => () => void
    onUpdateAvailable: (cb: (version: string) => void) => () => void

    updateHotkey: (hotkey: string) => Promise<{ ok: boolean; error?: string }>
    updateMicrophone: (deviceId: string) => Promise<{ ok: boolean; error?: string }>
    updateLanguage: (language: string) => Promise<{ ok: boolean; error?: string }>
    updateToggle: (
      key: 'showOverlay' | 'dictationSounds' | 'launchAtLogin',
      value: boolean,
    ) => Promise<{ ok: boolean; error?: string }>
    getSettings: () => Promise<Record<string, unknown>>

    getVersion: () => Promise<string>
    getPlatform: () => NodeJS.Platform

    minimizeWindow: () => void
    hideWindow: () => void

    setAuthToken: (token: string) => Promise<{ ok: boolean; error?: string; expiresAt?: number }>
    clearAuthToken: () => void

    startRecording: () => void
    stopRecording: () => void
  }

  interface Window {
    electronAPI?: SpeakflowElectronAPI
  }
}
