// Overlay renderer: CSS bar-based waveform (canvas avoided — GPU disabled in this app).
// Five vertical bars animate with audio levels; a thin handle collapses when not hovered.

const SAMPLE_COUNT = 5
const BAR_MAX_H = 20  // px — fits within the 24px bar container

const barsEl     = document.getElementById('bars')       as HTMLElement
const bars        = Array.from(barsEl.querySelectorAll('span')) as HTMLElement[]
const errorLabel  = document.getElementById('error-label') as HTMLElement
const displayed   = new Array<number>(SAMPLE_COUNT).fill(0)

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
const IDLE_BASES = [0.28, 0.52, 0.70, 0.52, 0.28]
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
    stopIdleAnim()
  })

  api.onRecordingStarted(() => {
    document.body.dataset.mode = 'recording'
    document.body.setAttribute('data-recording', '')
    stopIdleAnim()
  })

  api.onRecordingStopped(() => {
    document.body.dataset.mode = 'processing'
    setTimeout(() => {
      if (document.body.dataset.mode === 'processing') {
        document.body.dataset.mode = 'idle-anim'
        startIdleAnim()
      }
    }, 400)
  })

  api.onTransformStarting?.(() => {
    document.body.dataset.mode = 'transforming'
    document.body.setAttribute('data-recording', '')
    setTimeout(() => {
      if (document.body.dataset.mode === 'transforming') {
        document.body.dataset.mode = 'idle-anim'
        startIdleAnim()
      }
    }, 400)
  })

  api.onProcessingComplete(() => {
    // Don't wipe an error that's currently showing — let its own timeout clear it.
    if (document.body.dataset.mode === 'error') return
    stopIdleAnim()
    document.body.removeAttribute('data-recording')
    delete document.body.dataset.mode
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
}
