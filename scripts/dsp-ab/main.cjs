// Dev-only A/B harness for the microphone-DSP question (Phase 0).
//
// Opens TWO microphone streams from the same device at once — one with
// Chromium's voice-call DSP (echoCancellation/noiseSuppression/
// autoGainControl) ON, one with it fully OFF — and records both while the
// user reads a fixed script. Identical air, identical instant, identical
// words, so the only variable is the DSP. Recordings land in
// scripts/dsp-ab/takes/ and are scored by score.mjs.
//
// NEVER shipped: not referenced by main.ts, electron-builder.yml, or any
// npm script that participates in a build. Run it explicitly:
//   npx electron scripts/dsp-ab/main.cjs

const { app, BrowserWindow, ipcMain, session } = require('electron')
const path = require('path')
const fs = require('fs')

const TAKES_DIR = path.join(__dirname, 'takes')

function createWindow() {
  const win = new BrowserWindow({
    width: 940,
    height: 880,
    title: 'Speakflow — microphone DSP A/B',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // Electron blocks getUserMedia unless the session grants it.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  win.loadFile(path.join(__dirname, 'harness.html'))
}

ipcMain.handle('save-take', (_event, { take, arm, buffer }) => {
  fs.mkdirSync(TAKES_DIR, { recursive: true })
  const file = path.join(TAKES_DIR, `take${String(take).padStart(2, '0')}-${arm}.webm`)
  fs.writeFileSync(file, Buffer.from(buffer))
  return file
})

ipcMain.handle('takes-dir', () => TAKES_DIR)

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
