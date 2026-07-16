// Type declarations for the contextBridge API exposed to renderer windows.

export {}

interface SpeakflowCommand {
  id: string
  name: string
  description: string
  prompt: string
  hotkeyNumber: number
  model?: string
  order: number
  isSeeded: boolean
}

interface CommandsListResult {
  commands: SpeakflowCommand[]
  registeredHotkeys: Record<string, string>
}

interface CommandSaveResult {
  success: boolean
  error?: string
  command?: SpeakflowCommand
}

// Rich payload sent on 'transcription-complete'. Older app builds sent a
// plain string, so renderers must accept both shapes.
interface TranscriptionPayload {
  text: string
  durationSeconds: number
  appName: string | null
  windowTitle: string | null
  source: 'dictation' | 'transform'
}

declare global {
  interface SpeakflowElectronAPI {
    onRecordingStarting?: (cb: () => void) => () => void
    onRecordingStarted: (cb: () => void) => () => void
    onRecordingStopped: (cb: () => void) => () => void
    onProcessingStarted: (cb: () => void) => () => void
    onProcessingComplete: (cb: () => void) => () => void
    onTranscriptionComplete: (
      cb: (payload: string | TranscriptionPayload) => void,
    ) => () => void
    onTranscriptionError: (cb: (message: string) => void) => () => void
    onTranscriptionStatus?: (cb: (message: string) => void) => () => void
    // Streaming mode only: accumulated transcript-so-far while recording.
    onPartialTranscript?: (cb: (text: string) => void) => () => void
    onTransformStarting?: (cb: () => void) => () => void
    onAudioLevels?: (cb: (levels: number[]) => void) => () => void
    onOverlayHover?: (cb: (hovering: boolean) => void) => () => void
    onOverlayHandleHidden?: (cb: (hidden: boolean) => void) => () => void
    onHotkeyState?: (cb: (state: { accelerator: string }) => void) => () => void
    onNavigateTo: (cb: (route: string) => void) => () => void
    onUpdateAvailable: (cb: (version: string) => void) => () => void

    commands: {
      list: () => Promise<CommandsListResult>
      save: (cmd: Partial<SpeakflowCommand>) => Promise<CommandSaveResult>
      delete: (id: string) => Promise<{ success: boolean; error?: string }>
      resetDefaults: () => Promise<{ success: boolean }>
      run: (id: string) => Promise<{ success: boolean; error?: string }>
    }

    migrate: {
      fromWispr: () => Promise<{
        imported: number
        skipped: number
        failed: number
        total: number
        done: boolean
        error?: string
      }>
      status: () => Promise<{ running: boolean }>
      onProgress: (cb: (p: unknown) => void) => () => void
    }

    updateHotkey: (hotkey: string) => Promise<{ ok: boolean; error?: string }>
    updateMicrophone: (deviceId: string) => Promise<{ ok: boolean; error?: string }>
    updateLanguage: (language: string) => Promise<{ ok: boolean; error?: string }>
    updateToggle: (
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
    ) => Promise<{ ok: boolean; error?: string }>
    setChoiceSetting: (
      key: 'transcriptionMode' | 'transcriptionProvider' | 'streamingEngine',
      value: string,
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
