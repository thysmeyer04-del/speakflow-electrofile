import path from 'path'
import fs from 'fs'
import { exec } from 'child_process'
import log from 'electron-log/main'

export function playSound(kind: 'start' | 'stop'): void {
  const file = path.join(__dirname, '..', '..', 'assets', 'sounds', `${kind}.mp3`)
  if (!fs.existsSync(file)) return // silent no-op if sounds aren't shipped yet

  if (process.platform === 'darwin') {
    exec(`afplay "${file}"`, (err) => {
      if (err) log.debug('afplay failed', err)
    })
  } else if (process.platform === 'win32') {
    // PowerShell SoundPlayer only handles WAV. For MP3 fall back to launching
    // via shell, but suppress any UI it might spawn.
    exec(
      `powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([uri]'${file.replace(/\\/g, '/')}'); $p.Play(); Start-Sleep -Milliseconds 600"`,
      { timeout: 1500 },
      (err) => {
        if (err) log.debug('powershell play failed', err)
      },
    )
  } else {
    exec(`paplay "${file}" || aplay "${file}"`, (err) => {
      if (err) log.debug('linux play failed', err)
    })
  }
}
