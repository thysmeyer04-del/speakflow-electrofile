import { app, BrowserWindow, screen, session, shell } from 'electron'
import path from 'path'
import { config as dotenvConfig } from 'dotenv'
import log from 'electron-log/main'
import { setupTray, setTrayRecording, selfCheckTrayAssets } from './tray'
import { registerHotkey, unregisterHotkey } from './hotkey'
import { setupIPC } from './ipc'
import { setupAutoUpdater } from './updater'
import { requestStartupPermissions } from './permissions'
import { getSettings } from './settings'
import { initRecorder, destroyRecorder } from './recorder'
import { shutdownRecording } from './recording-controller'
import { isQuitting, markQuitting } from './quit-state'
import { configureSecurity, isExternalUrlAllowed, isOriginTrusted } from './security'

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
    if (isExternalUrlAllowed(url)) {
      shell.openExternal(url).catch((err) => log.warn('openExternal failed', err))
    } else {
      log.warn('Blocked window.open to disallowed URL', url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!isOriginTrusted(url)) {
      event.preventDefault()
      log.warn('Blocked navigation attempt', url)
    }
  })

  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  try {
    await win.loadURL(DASHBOARD_URL)
  } catch (err) {
    log.warn(`Failed to load dashboard at ${DASHBOARD_URL}`, err)
    const fallback = encodeURIComponent(`
      <!doctype html><html><head><meta charset="utf-8"><title>Speakflow</title>
      <style>body{font-family:system-ui,sans-serif;background:#FAF9F7;color:#1a1917;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
        padding:32px;text-align:center}h1{font-size:20px}code{background:#eee;padding:2px 6px;border-radius:4px}</style>
      </head><body><div><h1>Couldn't reach the Speakflow Dashboard</h1>
      <p>Expected at <code>${DASHBOARD_URL}</code>.</p>
      <p>If you're developing, run <code>npm run dev</code> in the dashboard project first.</p>
      </div></body></html>
    `)
    await win.loadURL(`data:text/html;charset=utf-8,${fallback}`)
  }

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
      preload: path.join(__dirname, '..', 'overlay', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.setIgnoreMouseEvents(true)

  // The overlay is a local file; deny ALL navigation and any window.open attempt.
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
    log.warn('Blocked overlay navigation')
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html')).catch((err) => {
    log.error('Failed to load overlay window', err)
  })

  return win
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

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // Only the main dashboard window may request permissions, and only for
    // 'media' (mic capture happens in the hidden recorder window which lives
    // in the same session). Everything else is denied.
    const senderId = webContents?.id
    const senderUrl = details?.requestingUrl ?? webContents?.getURL() ?? ''
    const isMain = senderId !== undefined && senderId === mainWindow?.webContents.id
    const isRecorder = senderUrl.startsWith('file://') && senderUrl.endsWith('/recorder.html')
    const allowList = isMain || isRecorder ? new Set(['media']) : new Set<string>()
    callback(allowList.has(permission))
  })
}

app.whenReady().then(async () => {
  hardenSession()

  await requestStartupPermissions()

  mainWindow = await createMainWindow()
  overlayWindow = createOverlayWindow()

  configureSecurity({
    allowedSenderId: mainWindow.webContents.id,
    allowedOrigin: DASHBOARD_URL,
  })

  selfCheckTrayAssets()
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

let shuttingDown = false
app.on('before-quit', (event) => {
  if (shuttingDown) return
  shuttingDown = true
  markQuitting()
  unregisterHotkey()
  event.preventDefault()
  shutdownRecording()
    .catch((err) => log.warn('Shutdown recording failed', err))
    .finally(() => {
      destroyRecorder()
      app.exit(0)
    })
})
