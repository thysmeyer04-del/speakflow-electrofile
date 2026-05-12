import { dialog, systemPreferences } from 'electron'
import log from 'electron-log/main'

export async function requestStartupPermissions(): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      const micGranted = await systemPreferences.askForMediaAccess('microphone')
      if (!micGranted) {
        await dialog.showMessageBox({
          type: 'warning',
          title: 'Microphone access required',
          message:
            'Speakflow needs microphone access to transcribe your voice. Open System Settings → Privacy & Security → Microphone and enable Speakflow.',
          buttons: ['OK'],
        })
      }

      const accessibilityTrusted = systemPreferences.isTrustedAccessibilityClient(true)
      if (!accessibilityTrusted) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'Accessibility access required',
          message:
            'Speakflow needs Accessibility access to type transcribed text into other apps. Open System Settings → Privacy & Security → Accessibility and enable Speakflow.',
          buttons: ['OK'],
        })
      }
    } catch (err) {
      log.warn('Permission check failed on macOS', err)
    }
  }
  // Windows / Linux: mic permission is requested by the renderer on first
  // getUserMedia() call; text injection needs no OS-level permission.
}
