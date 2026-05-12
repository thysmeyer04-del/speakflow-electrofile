// Tiny renderer for the floating overlay. Types come from src/types/electron-api.d.ts.

const overlay = document.getElementById('overlay')!
const pulse = document.getElementById('pulse')!
const label = document.getElementById('label')!

const api = window.electronAPI
if (api) {
  api.onRecordingStarted(() => {
    overlay.classList.add('visible')
    pulse.className = 'pulse'
    label.innerHTML = 'Listening<span class="sub">— press hotkey to stop</span>'
  })

  api.onRecordingStopped(() => {
    pulse.className = 'pulse processing'
    label.innerHTML = 'Transcribing<span class="sub">— almost done</span>'
  })

  api.onProcessingComplete(() => {
    overlay.classList.remove('visible')
  })

  api.onTranscriptionError((msg: string) => {
    pulse.className = 'pulse error'
    label.innerHTML = `<span style="color:#fca5a5">${escapeHtml(msg)}</span>`
    setTimeout(() => overlay.classList.remove('visible'), 2200)
  })
}

export {}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
