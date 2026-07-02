// Overlay renderer: CSS bar-based waveform (canvas avoided — GPU disabled in this app).
// Five vertical bars animate with audio levels; a thin handle collapses when not hovered.

const SAMPLE_COUNT = 11
const BAR_MAX_H = 22  // px — fits within the 26px bar container

const barsEl     = document.getElementById('bars')       as HTMLElement
const bars        = Array.from(barsEl.querySelectorAll('span')) as HTMLElement[]
const errorLabel  = document.getElementById('error-label') as HTMLElement
const statusLabel = document.getElementById('status-label') as HTMLElement
const displayed   = new Array<number>(SAMPLE_COUNT).fill(0)

function setStatus(text: string): void {
  if (statusLabel) statusLabel.textContent = text
}

// ── Audio level state ─────────────────────────────────────────────────────────
function applyLevels(levels: number[]): void {
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const src = Math.round(i * (levels.length - 1) / (SAMPLE_COUNT - 1))
    const raw = levels[src] ?? 0
    const v   = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
    displayed[i] = Math.max(v, displayed[i] * 0.82)  // quick attack, slow decay
  }
}

function renderBars(): void {
  bars.forEach((bar, i) => {
    bar.style.height = `${Math.max(4, Math.round(displayed[i] * BAR_MAX_H))}px`
  })
}

// ── Idle animation: slow breathing sine, bell-curve base (centre tallest) ────
const IDLE_BASES = [0.20, 0.30, 0.42, 0.54, 0.65, 0.70, 0.65, 0.54, 0.42, 0.30, 0.20]
let idleRaf: number | null = null

function idleTick(): void {
  const t = Date.now()
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    displayed[i] = IDLE_BASES[i] + 0.18 * Math.sin(i * 1.1 + t * 0.002)
  }
  renderBars()
  idleRaf = requestAnimationFrame(idleTick)
}

function startIdleAnim(): void {
  if (idleRaf !== null) return
  idleRaf = requestAnimationFrame(idleTick)
}

function stopIdleAnim(): void {
  if (idleRaf !== null) {
    cancelAnimationFrame(idleRaf)
    idleRaf = null
  }
}

// ── Decay interval — settles bars toward zero when not recording ──────────────
setInterval(() => {
  const mode = document.body.dataset.mode
  if (mode === 'recording') return
  if (mode === 'idle-anim') { startIdleAnim(); return }

  stopIdleAnim()
  let any = false
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    if (displayed[i] > 0.01) {
      displayed[i] *= 0.78
      any = true
    } else if (displayed[i] !== 0) {
      displayed[i] = 0
      any = true
    }
  }
  if (any) renderBars()
}, 50)

// ── DWM heartbeat — keeps GPU surface scheduled on Windows ───────────────────
let heartbeatToggle = false
setInterval(() => {
  heartbeatToggle = !heartbeatToggle
  document.body.dataset.tick = heartbeatToggle ? '1' : '0'
}, 500)

// ── IPC bindings ──────────────────────────────────────────────────────────────
const api = window.electronAPI
if (api) {
  api.onRecordingStarting?.(() => {
    document.body.dataset.mode = 'starting'
    document.body.setAttribute('data-recording', '')
    setStatus('Starting…')
    stopIdleAnim()
  })

  api.onRecordingStarted(() => {
    document.body.dataset.mode = 'recording'
    document.body.setAttribute('data-recording', '')
    setStatus('Listening')
    stopIdleAnim()
  })

  // Recording ended — the clip is now being transcribed. Hold the distinct
  // 'processing' visual (blue wave + label) until processing-complete fires;
  // the old 400ms demotion to idle-anim made listening and transcribing
  // look identical.
  api.onRecordingStopped(() => {
    document.body.dataset.mode = 'processing'
    setStatus('Transcribing…')
    stopIdleAnim()
  })

  api.onProcessingStarted?.(() => {
    if (document.body.dataset.mode !== 'processing') {
      document.body.dataset.mode = 'processing'
      setStatus('Transcribing…')
      stopIdleAnim()
    }
  })

  api.onTransformStarting?.(() => {
    document.body.dataset.mode = 'transforming'
    document.body.setAttribute('data-recording', '')
    setStatus('Rewriting…')
    stopIdleAnim()
  })

  // Progress messages from main (e.g. one-off local Whisper model download).
  api.onTranscriptionStatus?.((msg: string) => {
    if (msg) setStatus(msg)
  })

  api.onProcessingComplete(() => {
    // Don't wipe an error that's currently showing — let its own timeout clear it.
    if (document.body.dataset.mode === 'error') return
    stopIdleAnim()
    document.body.removeAttribute('data-recording')
    delete document.body.dataset.mode
    setStatus('')
    displayed.fill(0)
    renderBars()
  })

  api.onTranscriptionError((msg: string) => {
    errorLabel.textContent = msg || 'Something went wrong'
    document.body.dataset.mode = 'error'
    document.body.setAttribute('data-recording', '')
    setTimeout(() => {
      stopIdleAnim()
      document.body.removeAttribute('data-recording')
      delete document.body.dataset.mode
      errorLabel.textContent = ''
      setStatus('')
      displayed.fill(0)
      renderBars()
    }, 3500)
  })

  api.onAudioLevels?.((levels: number[]) => {
    if (document.body.dataset.mode !== 'recording') return
    applyLevels(levels)
    renderBars()
  })

  // Hover: expand/collapse pill
  api.onOverlayHover?.((hovering: boolean) => {
    document.body.toggleAttribute('data-hovering', hovering)
  })

  // Settings: hide/show the collapsed handle
  api.onOverlayHandleHidden?.((hidden: boolean) => {
    document.body.toggleAttribute('data-handle-hidden', hidden)
  })

  // Hotkey: update display label dynamically
  api.onHotkeyState?.((state: { accelerator: string }) => {
    const hotkeyLabelEl = document.getElementById('hotkey-label')
    if (hotkeyLabelEl && state && state.accelerator) {
      const displayKey = state.accelerator
        .replace(/\bControl\b/gi, 'Ctrl')
        .replace(/\bMeta\b/gi, 'Cmd')
        .replace(/\bCommandOrControl\b/gi, 'Ctrl')
        .replace(/\bCmdOrCtrl\b/gi, 'Ctrl')
      hotkeyLabelEl.textContent = `${displayKey} to dictate`
    }
  })
}
