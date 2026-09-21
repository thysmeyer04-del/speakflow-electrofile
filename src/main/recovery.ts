import { globalShortcut, Notification } from 'electron'
import log from 'electron-log/main'
import { pasteLastOutput } from './inject'
import { getRecordingState } from './recording-controller'
import { abortInFlightTransform } from './transform-controller'

export const RECOVERY_SHORTCUT = process.platform === 'darwin' ? 'Command+Control+V' : 'Alt+Shift+Z'
export async function recoverLastOutput(): Promise<void> {
  if (getRecordingState() !== 'idle') return
  abortInFlightTransform()
  try {
    const result = await pasteLastOutput()
    if (!result.ok && Notification.isSupported()) new Notification({
      title: 'Speakflow', body: result.error === 'empty-input'
        ? 'No output to recover in this session yet.'
        : 'Your text is on the clipboard. Focus an editable field and paste it.',
    }).show()
  } catch (err) { log.warn('[recovery] paste failed', err) }
}

export function registerRecoveryShortcut(): void {
  if (!globalShortcut.register(RECOVERY_SHORTCUT, () => { void recoverLastOutput() })) {
    log.warn(`[recovery] ${RECOVERY_SHORTCUT} is unavailable; use the tray menu.`)
  }
}
export function unregisterRecoveryShortcut(): void { globalShortcut.unregister(RECOVERY_SHORTCUT) }
