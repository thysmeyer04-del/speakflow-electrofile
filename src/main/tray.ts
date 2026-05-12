import { Tray, Menu, app, BrowserWindow, nativeImage, NativeImage } from 'electron'
import path from 'path'
import fs from 'fs'
import log from 'electron-log/main'
import { markQuitting } from './quit-state'
import { toggleRecording } from './recording-controller'

let tray: Tray | null = null

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

export function setupTray(mainWindow: BrowserWindow): void {
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

  const menu = Menu.buildFromTemplate([
    { label: 'Open Speakflow', click: showWindow },
    { type: 'separator' },
    {
      label: 'Start / Stop Recording',
      click: () => { void toggleRecording() },
    },
    { type: 'separator' },
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
    { type: 'separator' },
    {
      label: 'Quit Speakflow',
      click: () => {
        markQuitting()
        app.quit()
      },
    },
  ])

  tray.setContextMenu(menu)
  tray.on('double-click', showWindow)
}

export function setTrayRecording(recording: boolean): void {
  if (!tray || tray.isDestroyed()) return
  tray.setImage(loadIcon(recording ? 'tray-icon-recording.png' : 'tray-icon.png'))
  tray.setToolTip(recording ? 'Speakflow — Recording…' : 'Speakflow')
}

// Verify the bundled fallback at boot so missing-asset issues surface early.
export function selfCheckTrayAssets(): void {
  const tryIcon = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png')
  if (!fs.existsSync(tryIcon)) {
    log.warn(`Tray icon not bundled at expected path: ${tryIcon}`)
  }
}
