// Tiny renderer for the floating overlay. Types come from src/types/electron-api.d.ts.

const overlay = document.getElementById('overlay') as HTMLDivElement
const barsContainer = document.getElementById('bars') as HTMLDivElement

const BAR_COUNT = 13
// Per-bar smoothed height (0..1). Quick attack, slow decay — standard VU pattern.
const displayed = new Array<number>(BAR_COUNT).fill(0)
const barEls: HTMLSpanElement[] = []
for (let i = 0; i < BAR_COUNT; i++) {
  const el = document.createElement('span')
  el.style.setProperty('--h', '0')
  barsContainer.appendChild(el)
  barEls.push(el)
}

// Render loop. Even when no fresh level packet arrives, the loop applies decay
// so the bars settle to baseline instead of freezing mid-frame.
function paintBars(): void {
  for (let i = 0; i < BAR_COUNT; i++) {
    barEls[i].style.setProperty('--h', displayed[i].toFixed(3))
  }
}

function applyLevels(levels: number[]): void {
  const n = Math.min(BAR_COUNT, levels.length)
  for (let i = 0; i < n; i++) {
    const raw = levels[i]
    const v = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
    // Quick attack, slow decay (15% per frame at 30fps), with the live input
    // as a floor so the bar never visually dips below the actual signal.
    displayed[i] = Math.max(v, displayed[i] * 0.85)
  }
  paintBars()
}

// Setup state-driven idle decay: when no levels arrive (idle / processing /
// error), drift bars toward zero so they don't appear frozen.
setInterval(() => {
  if (overlay.dataset.mode === 'recording') return
  let any = false
  for (let i = 0; i < BAR_COUNT; i++) {
    if (displayed[i] > 0.005) {
      displayed[i] *= 0.78
      any = true
    } else if (displayed[i] !== 0) {
      displayed[i] = 0
      any = true
    }
  }
  if (any) paintBars()
}, 50)

// Compositor heartbeat. Windows DWM suspends the GPU surface of a transparent
// + alwaysOnTop window after ~5 s of idle; the next `.visible` toggle then
// pays a 100-500 ms cold-paint penalty. A 500 ms data-attribute tick keeps the
// surface scheduled. Negligible CPU; massively improves cold-press latency.
let heartbeatToggle = false
setInterval(() => {
  heartbeatToggle = !heartbeatToggle
  overlay.dataset.tick = heartbeatToggle ? '1' : '0'
}, 500)

function setMode(mode: 'starting' | 'recording' | 'processing' | 'transforming' | 'error'): void {
  overlay.dataset.mode = mode
}

const api = window.electronAPI
if (api) {
  api.onRecordingStarting?.(() => {
    overlay.classList.add('visible')
    setMode('starting')
  })

  api.onRecordingStarted(() => {
    overlay.classList.add('visible')
    setMode('recording')
  })

  api.onRecordingStopped(() => {
    setMode('processing')
    setTimeout(() => {
      if (overlay.dataset.mode === 'processing') {
        overlay.dataset.mode = 'idle-anim'
      }
    }, 400)
  })

  api.onTransformStarting?.(() => {
    overlay.classList.add('visible')
    setMode('transforming')
    setTimeout(() => {
      if (overlay.dataset.mode === 'transforming') {
        overlay.dataset.mode = 'idle-anim'
      }
    }, 400)
  })

  api.onProcessingComplete(() => {
    overlay.classList.remove('visible')
    delete overlay.dataset.mode
  })

  api.onTranscriptionError((_msg: string) => {
    setMode('error')
    setTimeout(() => {
      overlay.classList.remove('visible')
      delete overlay.dataset.mode
    }, 2400)
  })

  api.onAudioLevels?.((levels: number[]) => {
    // Levels only matter while we're actively recording. After stop the bars
    // continue to decay via the idle-decay interval above.
    if (overlay.dataset.mode !== 'recording') return
    applyLevels(levels)
  })
}
