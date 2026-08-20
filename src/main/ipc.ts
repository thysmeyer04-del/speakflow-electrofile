import { ipcMain, app, BrowserWindow, dialog, shell, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import log from 'electron-log/main'
import { getSettings, setSetting } from './settings'
import { updateHotkey, getLastRegistrationResult } from './hotkey'
import {
  startRecording,
  stopRecording,
  onRecordingStateChange,
  abortInFlightRecording,
} from './recording-controller'
import {
  getCommands,
  saveCommand,
  deleteCommand,
  resetToDefaults,
  type Command,
} from './commands-store'
import {
  registerCommandHotkeys,
  getRegisteredCommandHotkeys,
} from './commands-hotkey'
import { runTransform } from './transform-controller'
import { runWisprMigration, isWisprMigrationRunning } from './migrate-wispr'
import {
  assertTrustedSender,
  issueTrustedFrameNonce,
  validateHotkey,
  validateMicrophoneId,
  validateLanguage,
  validateToggleKey,
  validateChoiceSetting,
  validateAuthToken,
} from './security'
import { refreshUserContext, clearUserContext } from './user-context'
import { clearAsrToken, flushStreamingUsageOutbox, prewarmAsrToken } from './asr-token'
import { purgeOwnerOutbox } from './event-outbox'
import type { FlowcastController } from './flowcast/controller'

interface SetupArgs {
  mainWindow: BrowserWindow
  overlayWindow: BrowserWindow
  onRecordingStateChange?: (recording: boolean) => void
  flowcast: FlowcastController
}

let cachedAuthToken: string | null = null
let cachedTokenExpiresAt = 0
let cachedAuthOwner: string | null = null

export interface AuthContext {
  token: string
  ownerId: string
}

export function getAuthContext(): AuthContext | null {
  const token = getAuthToken()
  return token && cachedAuthOwner ? { token, ownerId: cachedAuthOwner } : null
}

// Safety margin — refuse tokens about to expire so a request doesn't blow up
// half-way through with a 401.
//
// Was 60 s, cut to 5 s on 2026-07-29: the margin created a guaranteed DEAD
// MINUTE before every hourly token rotation, in which getAuthToken() returned
// null and every dictation died with "Sign in via the dashboard" — losing the
// whole recording. Observed in the field: an 81-second dictation destroyed
// this way. A transcription POST takes ~1-2 s, so 5 s of remaining validity
// is ample, and Supabase rotates the token well before then anyway.
const TOKEN_FRESHNESS_MARGIN_MS = 5_000

export function getAuthToken(): string | null {
  if (!cachedAuthToken) return null
  if (cachedTokenExpiresAt && Date.now() > cachedTokenExpiresAt - TOKEN_FRESHNESS_MARGIN_MS) {
    if (Date.now() > cachedTokenExpiresAt) {
      cachedAuthToken = null
      cachedTokenExpiresAt = 0
      cachedAuthOwner = null
    }
    log.warn(
      '[auth] token within expiry margin — dictation will fall back/fail until the ' +
        'dashboard pushes a refreshed session',
    )
    return null
  }
  return cachedAuthToken
}

export function clearAuthTokenCache(): void {
  cachedAuthToken = null
  cachedTokenExpiresAt = 0
  cachedAuthOwner = null
}

/**
 * Wait briefly for a usable token to (re)appear before giving up on a
 * dictation. The dashboard renderer refreshes the Supabase session on its own
 * schedule and pushes the new JWT over `auth:set-token`; if a hotkey lands in
 * the seconds around a rotation, the token is momentarily absent. Without this
 * the recording is DESTROYED — the audio is already stopped and there is no
 * retry path (a real 81-second dictation was lost this way, 2026-07-29).
 *
 * Returns as soon as a token exists, or null after maxWaitMs. Costs nothing on
 * the normal path: the first check almost always hits.
 */
export async function ensureAuthToken(maxWaitMs = 3_000): Promise<string | null> {
  const immediate = getAuthToken()
  if (immediate) return immediate
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    const token = getAuthToken()
    if (token) {
      log.info('[auth] token reappeared while waiting — dictation continues')
      return token
    }
  }
  return null
}

interface PrivilegedIpcEnvelope<T> {
  nonce?: unknown
  payload?: T
}

function gatedOn<T>(channel: string, handler: (event: IpcMainEvent, payload: T) => void) {
  ipcMain.removeAllListeners(channel)
  ipcMain.on(channel, (event, rawEnvelope) => {
    const envelope = rawEnvelope as PrivilegedIpcEnvelope<T> | null
    if (!assertTrustedSender(event, channel, envelope?.nonce)) return
    handler(event, envelope?.payload as T)
  })
}

function gatedHandle<T, R>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, payload: T) => R | Promise<R>,
) {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (event, rawEnvelope) => {
    const envelope = rawEnvelope as PrivilegedIpcEnvelope<T> | null
    if (!assertTrustedSender(event, channel, envelope?.nonce)) {
      throw new Error('untrusted-sender')
    }
    return await handler(event, envelope?.payload as T)
  })
}

export function setupIPC({
  mainWindow,
  overlayWindow,
  onRecordingStateChange: trayCallback,
  flowcast,
}: SetupArgs): void {
  ipcMain.removeHandler('security:get-nonce')
  ipcMain.handle('security:get-nonce', (event) => {
    const nonce = issueTrustedFrameNonce(event)
    if (!nonce) throw new Error('untrusted-sender')
    return nonce
  })
  gatedHandle('app:version', () => app.getVersion())
  gatedHandle('hotkey:get-status', () => getLastRegistrationResult())

  gatedOn('window:minimize', () => {
    if (!mainWindow.isDestroyed()) mainWindow.minimize()
  })
  gatedOn('window:hide', () => {
    if (!mainWindow.isDestroyed()) mainWindow.hide()
  })

  gatedHandle('settings:get', () => getSettings())

  gatedHandle<string, { ok: boolean; error?: string; activeHotkey?: string }>(
    'settings:update-hotkey',
    async (_event, raw) => {
      const v = validateHotkey(raw)
      if (!v) return { ok: false, error: 'invalid-hotkey' }
      setSetting('hotkey', v)
      const ok = updateHotkey(v)
      const result = getLastRegistrationResult()
      log.info(`Hotkey requested ${v} → active=${result?.accelerator}`)
      return { ok, activeHotkey: result?.accelerator }
    },
  )

  gatedHandle<string, { ok: boolean; error?: string }>(
    'settings:update-microphone',
    (_event, raw) => {
      const v = validateMicrophoneId(raw)
      if (!v) return { ok: false, error: 'invalid-microphone' }
      setSetting('microphone', v)
      return { ok: true }
    },
  )

  gatedHandle<string, { ok: boolean; error?: string }>(
    'settings:update-language',
    (_event, raw) => {
      const v = validateLanguage(raw)
      if (!v) return { ok: false, error: 'invalid-language' }
      setSetting('language', v)
      return { ok: true }
    },
  )

  gatedHandle<{ key: unknown; value: unknown }, { ok: boolean; error?: string }>(
    'settings:update-toggle',
    (_event, raw) => {
      if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid-payload' }
      const key = validateToggleKey(raw.key)
      const value = raw.value
      if (!key) return { ok: false, error: 'invalid-key' }
      if (typeof value !== 'boolean') return { ok: false, error: 'invalid-value' }
      if (key === 'streamingTranscription') {
        // Segment-on-pause streaming was removed (Fast Batch, 2026-07): it
        // never produced a partial in production and Groq bills ≥10 s per
        // uploaded segment. Old deployed dashboards still send this toggle —
        // acknowledge it so they render success, but persist nothing.
        return { ok: true }
      }
      setSetting(key, value)
      if (key === 'launchAtLogin') {
        try {
          app.setLoginItemSettings({ openAtLogin: value })
        } catch (err) {
          log.warn('Failed to update login item settings', err)
        }
      }
      if (key === 'overlayHandleVisible' && overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay-handle-hidden', !value)
      }
      return { ok: true }
    },
  )

  // String-enum settings (engine controls). Strictly allowlisted in
  // security.ts — only transcriptionMode, transcriptionProvider and
  // streamingEngine, and only their known values, ever reach electron-store.
  gatedHandle<{ key: unknown; value: unknown }, { ok: boolean; error?: string }>(
    'settings:set-choice',
    (_event, raw) => {
      if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid-payload' }
      const validated = validateChoiceSetting(raw.key, raw.value)
      if (!validated) return { ok: false, error: 'invalid-choice' }
      // Narrow per key so setSetting gets a correlated key/value pair.
      if (validated.key === 'transcriptionMode') {
        setSetting('transcriptionMode', validated.value)
      } else if (validated.key === 'transcriptionProvider') {
        setSetting('transcriptionProvider', validated.value)
      } else if (validated.key === 'streamingEngine') {
        // True Streaming engine toggle — applies from the NEXT dictation
        // (doStart reads settings live); a recording in progress finishes on
        // whatever path it started with.
        setSetting('streamingEngine', validated.value)
        clearAsrToken()
        void prewarmAsrToken()
      } else if (validated.key === 'flowcastQuality') {
        setSetting('flowcastQuality', validated.value)
      } else if (validated.key === 'flowcastVisibility') {
        setSetting('flowcastVisibility', validated.value)
      } else {
        setSetting('flowcastStorageMode', validated.value)
      }
      return { ok: true }
    },
  )

  gatedHandle<string, { ok: boolean; error?: string; expiresAt?: number }>(
    'auth:set-token',
    (_event, raw) => {
      const result = validateAuthToken(raw)
      if (!result.ok) {
        log.warn(`Auth token rejected: ${result.reason}`)
        clearAuthTokenCache()
        // getAsrToken serves its cache BEFORE consulting getAuthToken — a
        // cleared JWT must always take the cached streaming grant with it.
        clearAsrToken()
        return { ok: false, error: result.reason }
      }
      cachedAuthToken = (raw as string).trim()
      cachedTokenExpiresAt = result.expiresAt ?? 0
      cachedAuthOwner = result.subject ?? null
      if (cachedAuthOwner && getSettings().flowcastEnabled) {
        void flowcast
          .recoverAbandonedSessions()
          .catch((err) => log.warn('[flowcast] signed-in recovery failed', err))
      }
      // The renderer writes the (possibly just-rotated) Supabase session to
      // localStorage immediately before pushing it here, so commit it to disk
      // now. Chromium flushes DOM storage lazily; without this a crash or
      // abrupt quit can drop the newest refresh token, and Supabase's
      // reuse-detection then revokes the whole session → forced re-login.
      // Best-effort and non-blocking.
      try {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.session.flushStorageData()
        }
      } catch (err) {
        log.warn('flushStorageData after auth:set-token failed', err)
      }
      // A Deepgram grant minted under the PREVIOUS token may belong to a
      // different identity — drop it so the next stream re-mints under this
      // one. (After a plain refresh this costs one cheap re-mint.)
      clearAsrToken()
      // …and immediately pre-mint under the NEW identity so the very next
      // dictation's streaming path starts with a cached grant instead of
      // paying mint latency inside the recording window. Fire-and-forget.
      void prewarmAsrToken()
      // Warm the personal dictionary + snippets cache now that we can make
      // RLS-authorized reads. Fire-and-forget — never blocks the auth reply.
      void refreshUserContext()
      const ownerAtSet = cachedAuthOwner
      const tokenAtSet = cachedAuthToken
      if (ownerAtSet && tokenAtSet) {
        void flushStreamingUsageOutbox(ownerAtSet, tokenAtSet)
          .then((events) => {
            if (mainWindow.isDestroyed() || cachedAuthOwner !== ownerAtSet) return
            for (const event of events) {
              mainWindow.webContents.mainFrame.send('transcription-complete', {
                protocolVersion: 2,
                text: event.text,
                durationSeconds: event.durationSeconds,
                appName: event.appContext,
                windowTitle: null,
                source: 'dictation',
                clientEventId: event.clientEventId,
                usageEventId: null,
                deletionGeneration: event.deletionGeneration,
                persisted: true,
              })
            }
          })
          .catch((err) => log.warn('[outbox] replay failed', err))
      }
      return { ok: true, expiresAt: result.expiresAt ?? 0 }
    },
  )
  gatedOn('auth:clear-token', () => {
    clearAuthTokenCache()
    // The signed-out user's streaming grant must die with their JWT.
    clearAsrToken()
    // Drop the signed-out user's dictionary/snippets so they can't leak
    // into another account's session.
    clearUserContext()
    // Also abort any recording/transcription in flight so a sign-out can't
    // leave a stale request continuing with the just-cleared token.
    // (This also aborts a live ASR socket via the controller's teardown.)
    abortInFlightRecording('auth-cleared')
    void flowcast.stop().catch((err) => log.warn('[flowcast] stop on sign-out failed', err))
  })

  gatedOn('recording:start', () => {
    startRecording().catch((err) => log.error('startRecording IPC failed', err))
  })
  gatedOn('recording:stop', () => {
    stopRecording().catch((err) => log.error('stopRecording IPC failed', err))
  })

  gatedHandle('flowcast:get-status', () => {
    const settings = getSettings()
    return {
      state: flowcast.getState(),
      elapsedMs: flowcast.elapsedMs(),
      enabled: settings.flowcastEnabled,
      storageMode: settings.flowcastStorageMode,
      exportDirectory: flowcast.resolveExportDirectory(settings.flowcastExportDirectory),
      lastSavedFile: flowcast.getLastCompletion()?.storageMode === 'onedrive'
        ? flowcast.getLastCompletion()?.location ?? null
        : null,
    }
  })
  gatedHandle('flowcast:probe', async () => {
    const caps = await flowcast.checkCapabilities()
    return { ok: Boolean(caps), caps }
  })
  gatedHandle('flowcast:start', async () => {
    const settings = getSettings()
    if (!settings.flowcastEnabled) return { ok: false, error: 'flowcast-disabled' }
    try {
      await flowcast.start({
        captureMic: settings.flowcastCaptureMic,
        captureSystemAudio: settings.flowcastCaptureSystemAudio,
        quality: settings.flowcastQuality,
        cursor: settings.flowcastCursor,
        visibility: settings.flowcastVisibility,
        storageMode: settings.flowcastStorageMode,
        exportDirectory: settings.flowcastExportDirectory,
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'flowcast-start-failed' }
    }
  })
  gatedHandle('flowcast:stop', async () => {
    const result = await flowcast.stop()
    return {
      ok: true,
      shareUrl: result?.storageMode === 'cloud' ? result.location : null,
      localFile: result?.storageMode === 'onedrive' ? result.location : null,
    }
  })
  gatedHandle('flowcast:discard', async () => {
    await flowcast.stop(true)
    return { ok: true }
  })
  gatedHandle('flowcast:choose-export-directory', async () => {
    const settings = getSettings()
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where Flowcast recordings are saved',
      defaultPath:
        flowcast.resolveExportDirectory(settings.flowcastExportDirectory) ?? app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    })
    const directory = selected.filePaths[0]
    if (selected.canceled || !directory) return { ok: false, error: 'cancelled' }
    setSetting('flowcastExportDirectory', directory)
    return { ok: true, directory }
  })
  gatedHandle('flowcast:open-export-directory', async () => {
    const settings = getSettings()
    const directory = flowcast.resolveExportDirectory(settings.flowcastExportDirectory)
    if (!directory) return { ok: false, error: 'onedrive-not-found' }
    await fs.promises.mkdir(directory, { recursive: true })
    const error = await shell.openPath(directory)
    return error ? { ok: false, error } : { ok: true }
  })
  gatedHandle('flowcast:open-last-recording', () => {
    const completion = flowcast.getLastCompletion()
    if (!completion || completion.storageMode !== 'onedrive') {
      return { ok: false, error: 'no-local-recording' }
    }
    shell.showItemInFolder(completion.location)
    return { ok: true }
  })

  gatedHandle<number, { ok: boolean; error?: string }>(
    'history:purge-local',
    async (_event, rawGeneration) => {
      if (!cachedAuthOwner) return { ok: false, error: 'not-authenticated' }
      if (!Number.isSafeInteger(rawGeneration) || rawGeneration < 0) {
        return { ok: false, error: 'invalid-generation' }
      }
      try {
        await purgeOwnerOutbox(cachedAuthOwner, rawGeneration)
        return { ok: true }
      } catch (error) {
        log.warn('[outbox] local history purge failed', error)
        return { ok: false, error: 'purge-failed' }
      }
    },
  )

  // ── Transform Commands ────────────────────────────────────────────────────
  gatedHandle('commands:list', () => ({
    commands: getCommands(),
    registeredHotkeys: getRegisteredCommandHotkeys(),
  }))
  gatedHandle<Partial<Command>, { success: boolean; error?: string; command?: Command }>(
    'commands:save',
    (_event, raw) => {
      if (!raw || typeof raw !== 'object') return { success: false, error: 'invalid-payload' }
      const result = saveCommand(raw)
      if (result.success) {
        // Re-register all hotkeys to reflect the change.
        registerCommandHotkeys(getCommands())
      }
      return result
    },
  )
  gatedHandle<string, { success: boolean; error?: string }>('commands:delete', (_event, id) => {
    if (typeof id !== 'string' || !id) return { success: false, error: 'invalid-id' }
    deleteCommand(id)
    registerCommandHotkeys(getCommands())
    return { success: true }
  })
  gatedHandle('commands:reset-defaults', () => {
    resetToDefaults()
    registerCommandHotkeys(getCommands())
    return { success: true }
  })
  gatedHandle<string, { success: boolean; error?: string }>('commands:run', async (_event, id) => {
    if (typeof id !== 'string' || !id) return { success: false, error: 'invalid-id' }
    try {
      await runTransform(id)
      return { success: true }
    } catch (err) {
      log.error('commands:run failed', err)
      return { success: false, error: (err as Error).message ?? 'unknown' }
    }
  })

  // ── One-shot migration from Wispr Flow ───────────────────────────────────
  gatedHandle('migrate:start-wispr-import', () => runWisprMigration())
  gatedHandle('migrate:status', () => ({ running: isWisprMigrationRunning() }))

  // Push initial settings and hotkey state once the overlay renderer is ready
  overlayWindow.webContents.on('did-finish-load', () => {
    if (!overlayWindow.isDestroyed()) {
      const visible = getSettings().overlayHandleVisible
      overlayWindow.webContents.send('overlay-handle-hidden', !visible)
      const hotkeyResult = getLastRegistrationResult()
      if (hotkeyResult) {
        overlayWindow.webContents.send('hotkey-state', hotkeyResult)
      }
    }
  })

  onRecordingStateChange((s) => {
    // Overlay window stays shown for the whole app lifetime; visibility is
    // controlled purely by CSS via 'recording-starting' / 'processing-
    // complete' events. We DON'T call show/hide here because the cold-paint
    // cost on first show is what made the overlay feel laggy.
    trayCallback?.(s === 'recording')
  })
}
