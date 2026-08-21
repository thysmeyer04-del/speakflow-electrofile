import { Tray, Menu, app, BrowserWindow, nativeImage, NativeImage, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import log from 'electron-log/main'
import { markQuitting } from './quit-state'
import { toggleRecording } from './recording-controller'
import { installPendingUpdate, checkForUpdatesNow, getPendingUpdateVersion } from './updater'
import type { FlowcastController, FlowcastState } from './flowcast/controller'
import { getSettings } from './settings'

let tray: Tray | null = null
// Rebuilding the context menu needs the window reference captured at setup.
let rebuildMenu: (() => void) | null = null
let dictationRecording = false
let flowcastState: FlowcastState = 'idle'

// Minimal 16x16 solid-colour PNG fallback if the real icon is missing.
const FALLBACK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJklEQVQ4T2NkYGD4z0AEYBxVSF1FQwj4DwQDxqDhUI3UVTDqAACkUgX7' +
  'fhJawAAAAABJRU5ErkJggg=='

function loadIcon(file: string): NativeImage {
  const iconPath = path.join(__dirname, '..', '..', 'assets', file)
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    log.warn(`Tray icon missing: ${iconPath} (using inline fallback)`)
    image = nativeImage.createFromBuffer(Buffer.from(FALLBACK_PNG_BASE64, 'base64'))
  }
  image = image.resize({ width: 18, height: 18 })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

export function setupTray(mainWindow: BrowserWindow, flowcast: FlowcastController): void {
  // Idempotent: tear down any prior tray before installing a new one.
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
    tray = null
  }

  tray = new Tray(loadIcon('tray-icon.png'))
  tray.setToolTip('Speakflow')

  const showWindow = () => {
    if (mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  // Menu is rebuilt whenever a downloaded update starts/stops waiting, so the
  // "Restart to update" entry can appear without an app restart. Before
  // v0.7.2 a pending update was announced by a single modal dialog and was
  // invisible everywhere else — Thys sat on a stale build for 12 days.
  rebuildMenu = () => {
    if (!tray || tray.isDestroyed()) return
    const pending = getPendingUpdateVersion()
    const flowcastSettings = getSettings()
    const flowcastEnabled = process.platform === 'win32' && flowcastSettings.flowcastEnabled
    const flowcastBusy = flowcastState !== 'idle'

    const menu = Menu.buildFromTemplate([
      ...(pending
        ? [
            {
              label: `⬆  Restart to update to ${pending}`,
              click: () => { installPendingUpdate() },
            },
            { type: 'separator' as const },
          ]
        : []),
      { label: 'Open Speakflow', click: showWindow },
      { type: 'separator' as const },
      {
        label: 'Start / Stop Recording',
        click: () => { void toggleRecording() },
      },
      {
        label: flowcastBusy
          ? 'Stop screen recording'
          : flowcastSettings.flowcastStorageMode === 'local'
            ? 'Start screen recording → Local folder'
            : 'Start screen recording',
        enabled: flowcastEnabled,
        click: () => {
          const settings = getSettings()
          const operation = flowcastBusy
            ? flowcast.stop()
            : flowcast.start({
                captureMic: settings.flowcastCaptureMic,
                captureSystemAudio: settings.flowcastCaptureSystemAudio,
                quality: settings.flowcastQuality,
                cursor: settings.flowcastCursor,
                clickHighlight: settings.flowcastClickHighlight,
                cameraEnabled: settings.flowcastCameraEnabled,
                cameraSize: settings.flowcastCameraSize,
                cameraX: settings.flowcastCameraX,
                cameraY: settings.flowcastCameraY,
                visibility: settings.flowcastVisibility,
                storageMode: settings.flowcastStorageMode,
                exportDirectory: settings.flowcastExportDirectory,
              })
          void operation.catch((error) => {
            log.warn('[flowcast] tray operation failed', error)
            dialog.showErrorBox(
              'Screen recording',
              error instanceof Error ? error.message : 'Screen recording failed.',
            )
          })
        },
      },
      { type: 'separator' as const },
      {
        label: 'Settings',
        click: () => {
          showWindow()
          mainWindow.webContents.send('navigate-to', '/settings/general')
        },
      },
      {
        label: `Version ${app.getVersion()}`,
        enabled: false,
      },
      {
        label: 'Check for updates…',
        click: () => {
          void checkForUpdatesNow().then((status) => {
            log.info(`[tray] manual update check: ${status}`)
            dialog.showMessageBox({
              type: 'info',
              title: 'Speakflow updates',
              message: status,
              buttons: ['OK'],
            }).catch(() => { /* dialog dismissed — nothing to do */ })
          })
        },
      },
      { type: 'separator' as const },
      {
        label: 'Quit Speakflow',
        click: () => {
          markQuitting()
          app.quit()
        },
      },
    ])

    tray.setContextMenu(menu)
    tray.setToolTip(pending ? `Speakflow — update ${pending} ready` : 'Speakflow')
  }

  rebuildMenu()
  tray.on('double-click', showWindow)
}

/** Called by the updater when a version starts (or stops) waiting to install. */
export function setTrayUpdatePending(version: string | null): void {
  log.info(`[tray] update pending: ${version ?? 'none'}`)
  rebuildMenu?.()
}

export function setTrayRecording(recording: boolean): void {
  if (!tray || tray.isDestroyed()) return
  dictationRecording = recording
  tray.setImage(loadIcon(recording || flowcastState !== 'idle' ? 'tray-icon-recording.png' : 'tray-icon.png'))
  if (recording || flowcastState !== 'idle') {
    tray.setToolTip('Speakflow — Recording…')
    return
  }
  // Idle: keep advertising a waiting update rather than clobbering it.
  const pending = getPendingUpdateVersion()
  tray.setToolTip(pending ? `Speakflow — update ${pending} ready` : 'Speakflow')
}

export function setTrayFlowcastState(state: FlowcastState): void {
  flowcastState = state
  if (tray && !tray.isDestroyed()) {
    tray.setImage(
      loadIcon(dictationRecording || state !== 'idle' ? 'tray-icon-recording.png' : 'tray-icon.png'),
    )
    tray.setToolTip(state === 'idle' ? 'Speakflow' : 'Speakflow — Screen recording…')
  }
  rebuildMenu?.()
}

// Verify the bundled fallback at boot so missing-asset issues surface early.
export function selfCheckTrayAssets(): void {
  const tryIcon = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png')
  if (!fs.existsSync(tryIcon)) {
    log.warn(`Tray icon not bundled at expected path: ${tryIcon}`)
  }
}
