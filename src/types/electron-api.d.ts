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
  protocolVersion?: 1 | 2
  clientEventId?: string | null
  usageEventId?: string | null
  deletionGeneration?: number
  persisted?: boolean
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
    flowcast: {
      status: () => Promise<{
        state: string
        elapsedMs: number
        enabled: boolean
        storageMode: 'local' | 'cloud'
        exportDirectory: string | null
        lastSavedFile: string | null
      }>
      probe: () => Promise<{ ok: boolean; caps: unknown }>
      start: (options?: {
        source?: { kind: 'monitor' | 'window'; index: number }
        cameraEnabled?: boolean
        cameraSize?: 'small' | 'medium' | 'large'
        clickHighlight?: boolean
      }) => Promise<{ ok: boolean; error?: string }>
      pause: () => Promise<{ ok: boolean; error?: string }>
      resume: () => Promise<{ ok: boolean; error?: string }>
      stop: () => Promise<{
        ok: boolean
        shareUrl: string | null
        localFile: string | null
      }>
      discard: () => Promise<{ ok: boolean }>
      chooseExportDirectory: () => Promise<{ ok: boolean; directory?: string; error?: string }>
      openExportDirectory: () => Promise<{ ok: boolean; error?: string }>
      openLastRecording: () => Promise<{ ok: boolean; error?: string }>
      onState: (cb: (payload: unknown) => void) => () => void
      onDone: (cb: (result: {
        storageMode: 'local' | 'cloud'
        location: string
      }) => void) => () => void
      onError: (cb: (message: string) => void) => () => void
    }

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
        | 'flowcastEnabled'
        | 'flowcastCaptureMic'
        | 'flowcastCaptureSystemAudio'
        | 'flowcastCursor'
        | 'flowcastClickHighlight'
        | 'flowcastCameraEnabled'
        | 'streamingTranscription',
      value: boolean,
    ) => Promise<{ ok: boolean; error?: string }>
    setChoiceSetting: (
      key:
        | 'transcriptionMode'
        | 'transcriptionProvider'
        | 'streamingEngine'
        | 'flowcastQuality'
        | 'flowcastVisibility'
        | 'flowcastStorageMode'
        | 'flowcastCameraSize',
      value: string,
    ) => Promise<{ ok: boolean; error?: string }>
    getSettings: () => Promise<Record<string, unknown>>

    getVersion: () => Promise<string>
    getPlatform: () => NodeJS.Platform

    minimizeWindow: () => void
    hideWindow: () => void

    setAuthToken: (token: string) => Promise<{ ok: boolean; error?: string; expiresAt?: number }>
    clearAuthToken: () => void
    purgeHistory: (deletionGeneration: number) => Promise<{ ok: boolean; error?: string }>

    startRecording: () => void
    stopRecording: () => void
  }

  interface Window {
    electronAPI?: SpeakflowElectronAPI
  }
}
