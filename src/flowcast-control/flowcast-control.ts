type StatePayload = { state: string; elapsedMs?: number }

interface FlowcastControlApi {
  getState: () => Promise<StatePayload>
  pauseOrResume: () => Promise<{ ok: boolean; error?: string }>
  stop: () => Promise<{ ok: boolean; error?: string }>
  discard: () => Promise<{ ok: boolean; error?: string }>
  onState: (callback: (payload: StatePayload) => void) => () => void
}

declare global {
  interface Window { flowcastControl: FlowcastControlApi }
}

const timer = document.querySelector<HTMLElement>('#timer')!
const status = document.querySelector<HTMLElement>('#status')!
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!
const stopButton = document.querySelector<HTMLButtonElement>('#stop')!
const discardButton = document.querySelector<HTMLButtonElement>('#discard')!

let state = 'starting'
let baseElapsedMs = 0
let stateReceivedAt = performance.now()

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
  pauseButton.textContent = state === 'paused' ? '▶ Resume' : 'Ⅱ Pause'
  status.textContent = state === 'starting'
    ? 'Starting capture…'
    : state === 'paused'
      ? 'Paused'
      : state === 'stopping' || state === 'saving'
        ? 'Saving safely…'
        : 'Recording'
  document.body.dataset.state = state
}

setInterval(() => {
  const elapsed = state === 'recording'
    ? baseElapsedMs + performance.now() - stateReceivedAt
    : baseElapsedMs
  timer.textContent = formatElapsed(elapsed)
}, 200)

pauseButton.addEventListener('click', async () => {
  pauseButton.disabled = true
  const result = await window.flowcastControl.pauseOrResume()
  if (!result.ok) pauseButton.disabled = false
})

stopButton.addEventListener('click', async () => {
  stopButton.disabled = true
  pauseButton.disabled = true
  discardButton.disabled = true
  status.textContent = 'Saving safely…'
  await window.flowcastControl.stop()
})

discardButton.addEventListener('click', async () => {
  if (!window.confirm('Discard this screen recording? This cannot be undone.')) return
  stopButton.disabled = true
  pauseButton.disabled = true
  discardButton.disabled = true
  status.textContent = 'Discarding…'
  await window.flowcastControl.discard()
})

window.flowcastControl.onState(render)
void window.flowcastControl.getState().then(render)

export {}
