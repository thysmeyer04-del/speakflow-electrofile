import { BrowserWindow, dialog, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log/main'

const CHECK_INTERVAL_MS = 60 * 60 * 1000

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  if (!app.isPackaged) {
    log.info('Auto-updater disabled in development.')
    return
  }

  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    log.info('Update available', info.version)
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info.version)
    }
  })

  autoUpdater.on('error', (err) => {
    log.warn('Auto-updater error', err)
  })

  autoUpdater.on('update-downloaded', async () => {
    const choice = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: 'A new version of Speakflow has been downloaded. Restart now to apply it.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice.response === 0) {
      autoUpdater.quitAndInstall()
    }
  })

  autoUpdater.checkForUpdates().catch((err) => log.warn('Initial update check failed', err))
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => log.warn('Periodic update check failed', err))
  }, CHECK_INTERVAL_MS)
}
