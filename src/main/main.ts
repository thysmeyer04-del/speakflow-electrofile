import { app, BrowserWindow, screen, session, shell } from 'electron'
import path from 'path'
import { config as dotenvConfig } from 'dotenv'
import log from 'electron-log/main'
import { setupTray, setTrayRecording } from './tray'
import { registerHotkey, unregisterHotkey } from './hotkey'
import { setupIPC } from './ipc'
import { setupAutoUpdater } from './updater'
import { requestStartupPermissions } from './permissions'
import { getSettings } from './settings'
import { initRecorder, destroyRecorder } from './recorder'
import { isQuitting, markQuitting } from './quit-state'

dotenvConfig()

log.initialize()
log.transports.file.level = 'info'
log.transports.console.level = 'debug'

const DASHBOARD_URL =
  process.env.DASHBOARD_URL ||
  (process.env.NODE_ENV === 'development'
    ? 'http://localhost:5173'
    : 'https://app.speakflow.app')

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#FAF9F7',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: resolveIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch((err) => log.warn('Failed to open external URL', err))
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault()
      log.warn('Blocked navigation attempt', url)
    }
  })

  await win.loadURL(DASHBOARD_URL)

  win.once('ready-to-show', () => {
    win.show()
  })

  win.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  return win
}

function createOverlayWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.workAreaSize

  const win = new BrowserWindow({
    width: 320,
    height: 64,
    x: Math.floor(width / 2 - 160),
    y: height - 96,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    resizable: false,
    movable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.setIgnoreMouseEvents(true)
  win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html')).catch((err) => {
    log.error('Failed to load overlay window', err)
  })

  return win
}

function isAllowedNavigation(url: string): boolean {
  try {
    const parsed = new URL(url)
    const dashboardOrigin = new URL(DASHBOARD_URL).origin
    return parsed.origin === dashboardOrigin
  } catch {
    return false
  }
}

function resolveIcon(): string | undefined {
  const file =
    process.platform === 'win32'
      ? 'icon.ico'
      : process.platform === 'darwin'
        ? 'icon.icns'
        : 'icon.png'
  return path.join(__dirname, '..', '..', 'assets', file)
}

function hardenSession() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    responseHeaders['X-Content-Type-Options'] = ['nosniff']
    callback({ responseHeaders })
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'clipboard-read', 'clipboard-sanitized-write']
    callback(allowed.includes(permission))
  })
}

app.whenReady().then(async () => {
  hardenSession()

  await requestStartupPermissions()

  mainWindow = await createMainWindow()
  overlayWindow = createOverlayWindow()

  setupTray(mainWindow)
  setupIPC({
    mainWindow,
    overlayWindow,
    onRecordingStateChange: (recording) => setTrayRecording(recording),
  })
  initRecorder()
  registerHotkey(getSettings().hotkey)
  setupAutoUpdater(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow().then((win) => {
        mainWindow = win
      })
    } else if (mainWindow) {
      mainWindow.show()
    }
  })
})

app.on('window-all-closed', () => {
  // Stay alive in the tray on all platforms. Quit happens via tray menu.
})

app.on('before-quit', () => {
  markQuitting()
  unregisterHotkey()
  destroyRecorder()
})
