import { Tray, Menu, app, BrowserWindow, nativeImage, NativeImage } from 'electron'
import path from 'path'
import log from 'electron-log/main'
import { markQuitting } from './quit-state'

let tray: Tray | null = null

function loadIcon(file: string): NativeImage {
  const iconPath = path.join(__dirname, '..', '..', 'assets', file)
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    log.warn(`Tray icon missing: ${iconPath} (using fallback)`)
    image = nativeImage.createEmpty()
  } else {
    image = image.resize({ width: 18, height: 18 })
  }
  if (process.platform === 'darwin') {
    image.setTemplateImage(true)
  }
  return image
}

export function setupTray(mainWindow: BrowserWindow): void {
  tray = new Tray(loadIcon('tray-icon.png'))
  tray.setToolTip('Speakflow')

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Speakflow',
      click: () => {
        mainWindow.show()
        mainWindow.focus()
      },
    },
    { type: 'separator' },
    {
      label: 'Start / Stop Recording',
      click: () => {
        // Lazy require to avoid circular import
        const { toggleRecording } = require('./audio') as typeof import('./audio')
        toggleRecording()
      },
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        mainWindow.show()
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
  tray.on('double-click', () => {
    mainWindow.show()
    mainWindow.focus()
  })
}

export function setTrayRecording(recording: boolean): void {
  if (!tray) return
  tray.setImage(loadIcon(recording ? 'tray-icon-recording.png' : 'tray-icon.png'))
  tray.setToolTip(recording ? 'Speakflow — Recording…' : 'Speakflow')
}
