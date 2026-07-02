// MUST be first import — side-effect-loads .env BEFORE any other module
// reads process.env at module-evaluation time. Without this, supabase.ts /
// transcribe.ts / migrate-wispr.ts capture empty strings into their
// module-level constants and silently no-op forever after.
import 'dotenv/config'

import { app, BrowserWindow, powerMonitor, screen, session, shell } from 'electron'

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')
import path from 'path'
import log from 'electron-log/main'
import { setupTray, setTrayRecording, selfCheckTrayAssets } from './tray'
import { registerHotkey, unregisterHotkey, reassertHotkey } from './hotkey'
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
import { warmupLocalWhisper } from './local-whisper'
import { shutdownRecording } from './recording-controller'
import { isQuitting, markQuitting } from './quit-state'
import { configureSecurity, isExternalUrlAllowed, isOriginTrusted } from './security'
import { warmupInject, registerOwnWindowPid, unregisterOwnWindowPid } from './inject'

log.initialize()
log.transports.file.level = 'info'
log.transports.console.level = 'debug'

const PRODUCTION_DASHBOARD = 'https://flow-speak.vercel.app'

// Always load the production dashboard by default. Set DASHBOARD_URL in .env
// only when actively developing the dashboard UI locally (e.g. localhost:5173).
const DASHBOARD_URL = process.env.DASHBOARD_URL || PRODUCTION_DASHBOARD

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

  // First load attempt. On failure, keep retrying every 4 s until the
  // network comes back — handles brief internet blips at startup.
  const loadDashboard = async (target: string): Promise<void> => {
    try {
      await win.loadURL(target)
    } catch (err) {
      log.warn(`Failed to load dashboard at ${target} — will retry`, err)
      // Show a lightweight reconnecting page so the window isn't just blank.
      const reconnecting = encodeURIComponent(
        `<!doctype html><html><head><meta charset="utf-8"><title>Speakflow</title>
        <style>body{font-family:system-ui,sans-serif;background:#FAF9F7;color:#1a1917;
          display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
          p{opacity:.6;font-size:15px}</style>
        </head><body><p>Connecting to Speakflow…</p></body></html>`
      )
      await win.loadURL(`data:text/html;charset=utf-8,${reconnecting}`).catch(() => undefined)

      // Retry loop — give up after 10 attempts (~40 s) and show a final error.
      let attempts = 0
      const retry = (): void => {
        if (win.isDestroyed()) return
        attempts++
        if (attempts > 10) {
          const fatal = encodeURIComponent(
            `<!doctype html><html><head><meta charset="utf-8"><title>Speakflow</title>
            <style>body{font-family:system-ui,sans-serif;background:#FAF9F7;color:#1a1917;
              display:flex;flex-direction:column;align-items:center;justify-content:center;
              height:100vh;margin:0;gap:12px}h1{font-size:18px;margin:0}
              button{padding:8px 20px;border-radius:6px;border:1px solid #ccc;cursor:pointer;font-size:14px}</style>
            </head><body><h1>Couldn't reach Speakflow</h1>
            <p style="opacity:.6;font-size:14px;margin:0">Check your internet connection.</p>
            <button onclick="location.href='${PRODUCTION_DASHBOARD}'">Try again</button>
            </body></html>`
          )
          win.loadURL(`data:text/html;charset=utf-8,${fatal}`).catch(() => undefined)
          return
        }
        win.loadURL(PRODUCTION_DASHBOARD).catch(() => {
          setTimeout(retry, 4000)
        })
      }
      setTimeout(retry, 4000)
    }
  }

  // Clear Electron's HTTP cache and any Vercel auth cookies before loading so
  // a cached "Authentication Required" page or a stale _vercel_jwt cookie
  // can't block the dashboard after protection is turned off in Vercel settings.
  await session.defaultSession.clearCache()
  await session.defaultSession.clearStorageData({
    origin: 'https://flow-speak.vercel.app',
    storages: ['cookies'],
  })

  // On first load: check if the stored Supabase session is expired and clear
  // it before the React app initialises. An expired token causes Supabase to
  // attempt a silent refresh that hangs indefinitely, keeping the app on its
  // loading screen. Clearing it forces a clean login instead.
  let tokenCheckDone = false
  win.webContents.on('did-finish-load', () => {
    if (tokenCheckDone || win.isDestroyed()) return
    tokenCheckDone = true
    win.webContents.executeJavaScript(`
      (() => {
        const key = 'sb-fyheufsexrfsatyhsmhe-auth-token'
        const raw = localStorage.getItem(key)
        if (!raw) return false
        try {
          const { expires_at } = JSON.parse(raw)
          if (typeof expires_at === 'number' && expires_at < Math.floor(Date.now() / 1000) + 60) {
            localStorage.removeItem(key)
            return true
          }
        } catch (_) { return false }
        return false
      })()
    `).then((cleared) => {
      if (cleared && !win.isDestroyed()) {
        log.info('[auth] Cleared expired Supabase token — reloading dashboard')
        win.webContents.reload()
      }
    }).catch(() => undefined)
  })

  await loadDashboard(DASHBOARD_URL)

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
    width: 480,
    height: 44,
    x: Math.floor(width / 2 - 240),
    y: height - 50,
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

  // 'screen-saver' is the highest standard always-on-top level — it keeps the
  // pill above maximized/fullscreen apps instead of sinking behind them, which
  // the default alwaysOnTop:true level does not guarantee on Windows.
  win.setAlwaysOnTop(true, 'screen-saver')
  // Keep it visible even when another app goes fullscreen, and across virtual
  // desktops, so the user never loses sight of the listening indicator.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Re-assert top-most periodically. setPosition (on monitor switch) and
  // foreground fullscreen transitions can quietly demote the window's z-order;
  // re-applying the level every 2 s pulls it back to the front. Cheap no-op
  // when it's already on top.
  const topMostKeepAlive = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(topMostKeepAlive); return }
    win.setAlwaysOnTop(true, 'screen-saver')
    if (!win.isVisible()) win.showInactive()
  }, 2_000)
  win.on('closed', () => clearInterval(topMostKeepAlive))

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

  // If the renderer crashes (GPU eviction, memory pressure, sleep/wake), reload
  // it automatically so the next hotkey press gets a live IPC listener.
  win.webContents.on('render-process-gone', (_event, details) => {
    log.warn('[overlay] renderer gone:', details.reason, '— reloading')
    if (!win.isDestroyed()) {
      win.webContents.reload()
    }
  })

  // After a reload (crash recovery or did-fail-load retry), re-show the window
  // so it is present at the OS compositor level before the next hotkey press.
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.showInactive()
    }
  })

  // Poll at 20 Hz: follow cursor across monitors and detect hover so the
  // renderer can expand/collapse the pill.
  let trackedDisplayId: number | null = null
  const cursorPoll = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(cursorPoll); return }
    const cursor  = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)

    // Jump to whichever monitor the cursor is on
    if (display.id !== trackedDisplayId) {
      trackedDisplayId = display.id
      const { x, y, width: dw, height: dh } = display.workArea
      win.setPosition(Math.floor(x + dw / 2 - 240), Math.floor(y + dh - 50))
      // setPosition can demote z-order on Windows — re-assert top-most.
      win.setAlwaysOnTop(true, 'screen-saver')
    }

    // Hover detection: only trigger when cursor is over the 56px handle,
    // not the entire transparent window area.
    const b = win.getBounds()
    const HANDLE_W = 120  // wider than 56px handle so it's easy to hit
    const HANDLE_H = 24   // generous height around the 4px line
    const hx = b.x + Math.floor((b.width  - HANDLE_W) / 2)
    const hy = b.y + Math.floor((b.height - HANDLE_H) / 2)
    const hovering =
      cursor.x >= hx && cursor.x <= hx + HANDLE_W &&
      cursor.y >= hy && cursor.y <= hy + HANDLE_H
    if (!win.isDestroyed()) win.webContents.send('overlay-hover', hovering)
  }, 50)

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

  // Re-show after system resume — Windows can hide always-on-top transparent
  // windows during sleep and not always restore them automatically.
  powerMonitor.on('resume', () => {
    if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
      overlayWindow.showInactive()
    }
    // Sleep/wake can silently drop a global shortcut on Windows — reclaim F11.
    reassertHotkey()
  })

  // Foreground app changes can leave another process holding our hotkey; every
  // time our own window regains focus, re-assert ownership of the preferred key.
  app.on('browser-window-focus', () => {
    reassertHotkey()
  })

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
  // On-device Whisper: preload the model (downloads it on very first run) so
  // the first dictation isn't hit by model-load latency. Deferred 5 s to keep
  // startup snappy; fire-and-forget.
  setTimeout(() => {
    const s = getSettings()
    const mode = process.env.SPEAKFLOW_TRANSCRIPTION_MODE || s.transcriptionMode
    if (mode === 'local') {
      warmupLocalWhisper(
        process.env.SPEAKFLOW_LOCAL_WHISPER_MODEL || s.localWhisperModel,
      )
    }
  }, 5000)
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
