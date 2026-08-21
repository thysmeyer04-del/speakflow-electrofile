(() => {
type InkColor = 'red' | 'yellow' | 'green' | 'blue' | 'white'
type CameraSize = 'small' | 'medium' | 'large'
type StatePayload = {
  state: string
  elapsedMs?: number
  cameraVisible?: boolean
  cameraSize?: CameraSize
  drawing?: boolean
  inkColor?: InkColor
  inkWidth?: number
}

interface FlowcastControlApi {
  getState: () => Promise<StatePayload>
  pauseOrResume: () => Promise<{ ok: boolean; error?: string }>
  stop: () => Promise<{ ok: boolean; error?: string }>
  discard: () => Promise<{ ok: boolean; error?: string }>
  restart: () => Promise<{ ok: boolean; error?: string }>
  toggleCamera: () => Promise<{ ok: boolean; visible?: boolean; size?: CameraSize }>
  cycleCameraSize: () => Promise<{ ok: boolean; visible?: boolean; size?: CameraSize }>
  toggleDrawing: () => Promise<{ ok: boolean; enabled?: boolean; color?: InkColor; width?: number }>
  setInkColor: (color: InkColor) => Promise<{ ok: boolean; enabled?: boolean; color?: InkColor; width?: number }>
  cycleInkWidth: () => Promise<{ ok: boolean; enabled?: boolean; color?: InkColor; width?: number }>
  clearInk: () => Promise<{ ok: boolean }>
  onState: (callback: (payload: StatePayload) => void) => () => void
}

const api = (window as unknown as { flowcastControl: FlowcastControlApi }).flowcastControl

const timer = document.querySelector<HTMLElement>('#timer')!
const status = document.querySelector<HTMLElement>('#status')!
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!
const stopButton = document.querySelector<HTMLButtonElement>('#stop')!
const discardButton = document.querySelector<HTMLButtonElement>('#discard')!
const cameraButton = document.querySelector<HTMLButtonElement>('#camera')!
const cameraSizeButton = document.querySelector<HTMLButtonElement>('#camera-size')!
const drawButton = document.querySelector<HTMLButtonElement>('#draw')!
const colorSelect = document.querySelector<HTMLSelectElement>('#color')!
const widthButton = document.querySelector<HTMLButtonElement>('#width')!
const clearButton = document.querySelector<HTMLButtonElement>('#clear')!
const restartButton = document.querySelector<HTMLButtonElement>('#restart')!

let state = 'starting'
let baseElapsedMs = 0
let stateReceivedAt = performance.now()
let cameraVisible = false
let cameraSize: CameraSize = 'small'
let drawing = false
let inkColor: InkColor = 'red'
let inkWidth = 7

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function render(payload: StatePayload): void {
  state = payload.state
  baseElapsedMs = payload.elapsedMs ?? baseElapsedMs
  stateReceivedAt = performance.now()
  const interactive = state === 'recording' || state === 'paused'
  pauseButton.disabled = !interactive
  stopButton.disabled = !interactive
  discardButton.disabled = !interactive
  for (const tool of [cameraButton, drawButton, colorSelect, widthButton, clearButton, restartButton]) {
    tool.disabled = !interactive
  }
  pauseButton.textContent = state === 'paused' ? '▶ Resume' : 'Ⅱ Pause'
  status.textContent = state === 'starting'
    ? 'Starting capture…'
    : state === 'paused'
      ? 'Paused'
      : state === 'stopping' || state === 'saving'
        ? 'Saving safely…'
        : 'Recording'
  document.body.dataset.state = state
  if (typeof payload.cameraVisible === 'boolean') cameraVisible = payload.cameraVisible
  if (payload.cameraSize) cameraSize = payload.cameraSize
  if (typeof payload.drawing === 'boolean') drawing = payload.drawing
  if (payload.inkColor) inkColor = payload.inkColor
  if (typeof payload.inkWidth === 'number') inkWidth = payload.inkWidth
  renderTools()
}

function renderTools(): void {
  document.body.dataset.camera = String(cameraVisible)
  document.body.dataset.drawing = String(drawing)
  cameraButton.textContent = cameraVisible ? 'Camera on' : 'Camera off'
  cameraSizeButton.textContent = cameraSize === 'small' ? 'S' : cameraSize === 'medium' ? 'M' : 'L'
  cameraSizeButton.disabled = !cameraVisible || (state !== 'recording' && state !== 'paused')
  drawButton.textContent = drawing ? 'Drawing' : 'Pen'
  colorSelect.value = inkColor
  colorSelect.style.background = {
    red: '#ff4652', yellow: '#ffd646', green: '#46dc87', blue: '#4a97ff', white: '#ffffff',
  }[inkColor]
  widthButton.textContent = `${inkWidth}px`
}

setInterval(() => {
  const elapsed = state === 'recording'
    ? baseElapsedMs + performance.now() - stateReceivedAt
    : baseElapsedMs
  timer.textContent = formatElapsed(elapsed)
}, 200)

pauseButton.addEventListener('click', async () => {
  pauseButton.disabled = true
  const result = await api.pauseOrResume()
  if (!result.ok) pauseButton.disabled = false
})

stopButton.addEventListener('click', async () => {
  stopButton.disabled = true
  pauseButton.disabled = true
  discardButton.disabled = true
  status.textContent = 'Saving safely…'
  await api.stop()
})

discardButton.addEventListener('click', async () => {
  if (!window.confirm('Discard this screen recording? This cannot be undone.')) return
  stopButton.disabled = true
  pauseButton.disabled = true
  discardButton.disabled = true
  status.textContent = 'Discarding…'
  await api.discard()
})

cameraButton.addEventListener('click', async () => {
  const result = await api.toggleCamera()
  if (result.ok) {
    cameraVisible = Boolean(result.visible)
    if (result.size) cameraSize = result.size
    renderTools()
  }
})
cameraSizeButton.addEventListener('click', async () => {
  const result = await api.cycleCameraSize()
  if (result.ok && result.size) {
    cameraSize = result.size
    renderTools()
  }
})
drawButton.addEventListener('click', async () => {
  const result = await api.toggleDrawing()
  if (result.ok) {
    drawing = Boolean(result.enabled)
    renderTools()
  }
})
colorSelect.addEventListener('change', async () => {
  const result = await api.setInkColor(colorSelect.value as InkColor)
  if (result.ok && result.color) {
    inkColor = result.color
    renderTools()
  }
})
widthButton.addEventListener('click', async () => {
  const result = await api.cycleInkWidth()
  if (result.ok && typeof result.width === 'number') {
    inkWidth = result.width
    renderTools()
  }
})
clearButton.addEventListener('click', () => { void api.clearInk() })
restartButton.addEventListener('click', async () => {
  if (!window.confirm('Discard this take and restart immediately?')) return
  restartButton.disabled = true
  status.textContent = 'Restarting…'
  const result = await api.restart()
  if (!result.ok) restartButton.disabled = false
})

api.onState(render)
void api.getState().then(render)
})()
