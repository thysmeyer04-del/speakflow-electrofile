// MUST be first import — side-effect-loads .env BEFORE any other module
// reads process.env at module-evaluation time. Without this, supabase.ts /
// transcribe.ts / migrate-wispr.ts capture empty strings into their
// module-level constants and silently no-op forever after.
import 'dotenv/config'

import { app, BrowserWindow, screen, session, shell } from 'electron'

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')
import path from 'path'
import log from 'electron-log/main'
import { setupTray, setTrayRecording, selfCheckTrayAssets } from './tray'
import { registerHotkey, unregisterHotkey } from './hotkey'
import { initCommandsStore, getCommands } from './commands-store'
import {
  registerCommandHotkeys,
  unregisterAllCommandHotkeys,
} from './commands-hotkey'
import { setupIPC } from './ipc'
import { setupAutoUpdater } from './updater'
import { requestStartupPermissions } from './permissions'
import { getSettings } from './settings'
import { initRecorder, destroyRecorder, setLevelTargetWindow, warmupRecorderMic } from './recorder'
import { shutdownRecording } from './recording-controller'
import { isQuitting, markQuitting } from './quit-state'
import { configureSecurity, isExternalUrlAllowed, isOriginTrusted } from './security'
import { warmupInject, registerOwnWindowPid, unregisterOwnWindowPid } from './inject'

log.initialize()
log.transports.file.level = 'info'
log.transports.console.level = 'debug'

const DASHBOARD_URL =
  process.env.DASHBOARD_URL ||
  (process.env.NODE_ENV === 'development'
    ? 'http://localhost:5173'
    : 'https://flow-speak.vercel.app')

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

  // Forward dashboard renderer console to main log (dev only) so failures
  // in IPC / Supabase writes are visible without opening DevTools.
  if (process.env.NODE_ENV === 'development') {
    win.webContents.on('console-message', (_e, level, message, line, src) => {
      const lvl = ['debug', 'info', 'warn', 'error'][level] ?? 'info'
      log.info(`[dashboard:${lvl}] ${message} (${src}:${line})`)
    })
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrlAllowed(url)) {
      shell.openExternal(url).catch((err) => log.warn('openExternal failed', err))
    } else {
      log.warn('Blocked window.open to disallowed URL', url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    try {
      const { hostname } = new URL(url)
      // Allow OAuth providers and Supabase auth endpoints through
      const oauthHosts = [
        'accounts.google.com',
        'fyheufsexrfsatyhsmhe.supabase.co',
        'flow-speak.vercel.app',
      ]
      if (oauthHosts.includes(hostname)) return
    } catch { /* unparseable url — fall through to block */ }

    if (!isOriginTrusted(url)) {
      event.preventDefault()
      log.warn('Blocked navigation attempt', url)
    }
  })

  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  // Track our PIDs so inject.ts can refuse to type into Speakflow itself.
  // We register BOTH the main process and the renderer process — nut-js
  // may report either as the active window owner depending on platform.
  //
  // process.pid is registered ONCE at startup and intentionally never
  // unregistered while the app is alive — it identifies us for the entire
  // process lifetime. before-quit doesn't bother either; we're exiting.
  //
  // Renderer PID can change on reload/crash-recovery; we re-register on
  // every did-finish-load and unregister on window close.
  registerOwnWindowPid(process.pid)
  const previousRendererPids = new Set<number>()
  const refreshRendererPid = () => {
    try {
      const pid = win.webContents.getOSProcessId()
      if (pid > 0 && !previousRendererPids.has(pid)) {
        registerOwnWindowPid(pid)
        previousRendererPids.add(pid)
      }
    } catch (err) {
      log.warn('Could not register renderer PID for self-paste guard', err)
    }
  }
  win.webContents.on('did-finish-load', refreshRendererPid)
  win.webContents.on('render-process-gone', refreshRendererPid)
  win.once('closed', () => {
    for (const pid of previousRendererPids) unregisterOwnWindowPid(pid)
    previousRendererPids.clear()
    // Note: process.pid is NOT unregistered here — see comment above.
  })

  // Configure security before loadURL so will-navigate isn't blocked on first load.
  configureSecurity({
    allowedSenderId: win.webContents.id,
    allowedOrigin: DASHBOARD_URL,
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
    width: 200,
    height: 52,
    x: Math.floor(width / 2 - 100),
    y: height - 72,
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
      // Critical: without this, Chromium throttles the overlay to 1fps when
      // it isn't focused, so IPC handlers can take up to a second to fire.
      // We need the overlay responsive at all times even though it can never
      // receive focus.
      backgroundThrottling: false,
    },
  })

  win.setIgnoreMouseEvents(true)

  if (process.env.NODE_ENV === 'development') {
    win.webContents.on('console-message', (_e, level, message, line, src) => {
      const lvl = ['debug', 'info', 'warn', 'error'][level] ?? 'info'
      log.info(`[overlay:${lvl}] ${message} (${src}:${line})`)
    })
  }

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

  // Show the overlay window immediately at startup so its first paint cost
  // is paid before the user ever presses the hotkey. The .visible CSS class
  // (controlled by recording-starting / processing-complete events) decides
  // whether anything is actually rendered.
  overlayWindow.showInactive()


  selfCheckTrayAssets()
  setupTray(mainWindow)
  setupIPC({
    mainWindow,
    overlayWindow,
    onRecordingStateChange: (recording) => setTrayRecording(recording),
  })
  initRecorder()
  setLevelTargetWindow(overlayWindow)
  // Warm up the mic stream ~2 s after launch so the recorder window is ready.
  // First F11 press then skips getUserMedia entirely — near-zero start latency.
  setTimeout(() => warmupRecorderMic(getSettings().microphone ?? 'default'), 2000)
  registerHotkey(getSettings().hotkey)
  initCommandsStore()
  registerCommandHotkeys(getCommands())
  setupAutoUpdater(mainWindow)

  // Pre-warm nut-js so the first F11 doesn't pay a 3-second cold-init
  // penalty. Fire-and-forget; if it fails the first capture just falls
  // through normally.
  warmupInject().catch((err) => log.warn('warmupInject failed', err))

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
  unregisterAllCommandHotkeys()
  event.preventDefault()
  shutdownRecording()
    .catch((err) => log.warn('Shutdown recording failed', err))
    .finally(() => {
      destroyRecorder()
      app.exit(0)
    })
})
