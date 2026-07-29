import { BrowserWindow, app, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log/main'
import { markQuitting } from './quit-state'

// Auto-update for a TRAY app.
//
// Why this file was rewritten (2026-07-29): v0.7.1 shipped three fixes Thys
// was actively suffering from, and 12 days later his machine was still on
// v0.7.0 — the installer sat downloaded-but-uninstalled in the updater cache
// the entire time. Root cause is structural:
//   1. main.ts's `win.on('close')` hides to tray instead of quitting, so the
//      app essentially NEVER emits 'quit' → `autoInstallOnAppQuit` never
//      fires. Only the tray's "Quit Speakflow" gets there.
//   2. The old code announced the update with ONE modal dialog. Miss it (or
//      click "Later") and the update was invisible forever — no tray hint,
//      no second prompt, nothing in the UI.
// So: announce with a clickable OS notification, keep a permanent tray entry
// while an update waits, and re-nudge on a schedule that escalates. Every
// state transition is logged under [updater] so "why is he not on the latest
// build?" is answerable from main.log alone.

const CHECK_INTERVAL_MS = 60 * 60 * 1000
// Re-announce a waiting update this often; after STALE_AFTER_MS the nudge
// escalates to hourly (a build waiting a full day means the user never saw
// the first notifications).
const RENUDGE_INTERVAL_MS = 4 * 60 * 60 * 1000
const STALE_RENUDGE_INTERVAL_MS = 60 * 60 * 1000
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

let pendingVersion: string | null = null
let pendingSince = 0
let lastNudgeAt = 0
let onPendingChange: ((version: string | null) => void) | null = null

/** Version waiting to be installed, or null. Read by the tray menu. */
export function getPendingUpdateVersion(): string | null {
  return pendingVersion
}

/** Quit and run the downloaded installer. Returns false when nothing is
 *  pending. markQuitting() first — without it the window's close handler
 *  preventDefaults and the quit (and therefore the install) never happens. */
export function installPendingUpdate(): boolean {
  if (!pendingVersion) {
    log.info('[updater] install requested but nothing is pending')
    return false
  }
  log.info(`[updater] installing ${pendingVersion} — quitting now`)
  markQuitting()
  // Defer past the current tick so a tray-menu click finishes dispatching
  // before the app tears down.
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      log.error('[updater] quitAndInstall threw', err)
    }
  })
  return true
}

function nudge(force = false): void {
  if (!pendingVersion) return
  const now = Date.now()
  const waited = now - pendingSince
  const interval = waited > STALE_AFTER_MS ? STALE_RENUDGE_INTERVAL_MS : RENUDGE_INTERVAL_MS
  if (!force && now - lastNudgeAt < interval) return
  lastNudgeAt = now

  const hours = Math.floor(waited / 3_600_000)
  log.info(`[updater] ${pendingVersion} pending for ${hours}h — notifying`)
  if (!Notification.isSupported()) return
  try {
    const notification = new Notification({
      title: `Speakflow ${pendingVersion} is ready`,
      body:
        hours >= 24
          ? 'This update has been waiting a while. Click to restart and apply it.'
          : 'Click to restart Speakflow and finish updating.',
    })
    notification.on('click', () => {
      installPendingUpdate()
    })
    notification.show()
  } catch (err) {
    log.warn('[updater] notification failed', err)
  }
}

function setPending(version: string | null): void {
  pendingVersion = version
  pendingSince = version ? Date.now() : 0
  lastNudgeAt = 0
  onPendingChange?.(version)
}

export interface UpdaterHooks {
  /** Called whenever a version starts/stops waiting for install — the tray
   *  uses it to show a "Restart to update" entry. */
  onPendingChange?: (version: string | null) => void
}

export function setupAutoUpdater(mainWindow: BrowserWindow, hooks: UpdaterHooks = {}): void {
  if (!app.isPackaged) {
    log.info('[updater] disabled in development.')
    return
  }

  onPendingChange = hooks.onPendingChange ?? null

  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    log.info(`[updater] checking (current ${app.getVersion()})`)
  })

  autoUpdater.on('update-available', (info) => {
    log.info(`[updater] available: ${info.version} (current ${app.getVersion()})`)
    // A newer build supersedes whatever was waiting — drop the stale pending
    // state so the tray/notifications track the version actually downloading.
    if (pendingVersion && pendingVersion !== info.version) {
      log.info(`[updater] ${info.version} supersedes pending ${pendingVersion}`)
      setPending(null)
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info.version)
    }
  })

  autoUpdater.on('update-not-available', () => {
    log.info('[updater] up to date')
  })

  autoUpdater.on('error', (err) => {
    log.warn('[updater] error', err)
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[updater] downloaded ${info.version} — waiting for restart`)
    setPending(info.version)
    nudge(true)
  })

  void autoUpdater.checkForUpdates().catch((err) => log.warn('[updater] initial check failed', err))
  const timer = setInterval(() => {
    // Nudge first: a pending update that the user has not acted on is more
    // actionable than the check itself, and the check is a no-op while one
    // is already downloaded.
    nudge()
    autoUpdater.checkForUpdates().catch((err) => log.warn('[updater] periodic check failed', err))
  }, CHECK_INTERVAL_MS)
  timer.unref?.()
}

/** Manual "Check for updates" (tray). Resolves to a short status string so
 *  the caller can surface the outcome. */
export async function checkForUpdatesNow(): Promise<string> {
  if (!app.isPackaged) return 'Updates are disabled in development.'
  if (pendingVersion) {
    nudge(true)
    return `Speakflow ${pendingVersion} is downloaded — restart to apply it.`
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version
    if (version && version !== app.getVersion()) return `Downloading Speakflow ${version}…`
    return `You're on the latest version (${app.getVersion()}).`
  } catch (err) {
    log.warn('[updater] manual check failed', err)
    return 'Could not check for updates — check your connection.'
  }
}
