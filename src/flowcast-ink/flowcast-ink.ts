(() => {
type InkColor = 'red' | 'yellow' | 'green' | 'blue' | 'white'
type Point = { x: number; y: number }
type Stroke = { color: InkColor; width: number; points: Point[]; created: number }

interface InkBridge {
  stroke(payload: { color: InkColor; width: number; points: Point[] }): void
  exit(): void
  onConfigure(callback: (payload: unknown) => void): () => void
  onClear(callback: () => void): () => void
  onReset(callback: () => void): () => void
}

const api = (window as unknown as { flowcastInk: InkBridge }).flowcastInk
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!
const context = canvas.getContext('2d')!
const colors: Record<InkColor, string> = {
  red: '#ff4652',
  yellow: '#ffd646',
  green: '#46dc87',
  blue: '#4a97ff',
  white: '#ffffff',
}

let enabled = false
let color: InkColor = 'red'
let width = 7
let drawing: Stroke | null = null
let strokes: Stroke[] = []

function resize(): void {
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.max(1, Math.round(innerWidth * ratio))
  canvas.height = Math.max(1, Math.round(innerHeight * ratio))
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
}

function pointFromEvent(event: PointerEvent): Point {
  return {
    x: Math.max(0, Math.min(1, event.clientX / Math.max(1, innerWidth))),
    y: Math.max(0, Math.min(1, event.clientY / Math.max(1, innerHeight))),
  }
}

function render(now: number): void {
  context.clearRect(0, 0, innerWidth, innerHeight)
  strokes = strokes.filter((stroke) => now - stroke.created < 5_000)
  for (const stroke of strokes) drawStroke(stroke, now)
  if (drawing) drawStroke(drawing, now)
  requestAnimationFrame(render)
}

function drawStroke(stroke: Stroke, now: number): void {
  if (stroke.points.length < 2) return
  const age = now - stroke.created
  const alpha = age <= 4_200 ? 0.94 : Math.max(0, (5_000 - age) / 800) * 0.94
  context.save()
  context.globalAlpha = alpha
  context.strokeStyle = colors[stroke.color]
  context.lineWidth = stroke.width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  context.moveTo(stroke.points[0].x * innerWidth, stroke.points[0].y * innerHeight)
  for (const point of stroke.points.slice(1)) {
    context.lineTo(point.x * innerWidth, point.y * innerHeight)
  }
  context.stroke()
  context.restore()
}

canvas.addEventListener('pointerdown', (event) => {
  if (!enabled || event.button !== 0) return
  canvas.setPointerCapture(event.pointerId)
  drawing = { color, width, points: [pointFromEvent(event)], created: performance.now() }
})

canvas.addEventListener('pointermove', (event) => {
  if (!drawing || !enabled) return
  const point = pointFromEvent(event)
  const previous = drawing.points[drawing.points.length - 1]
  const distance = Math.hypot(point.x - previous.x, point.y - previous.y)
  if (distance >= 0.0015 && drawing.points.length < 512) drawing.points.push(point)
})

function finishStroke(): void {
  if (!drawing) return
  if (drawing.points.length >= 2) {
    strokes.push(drawing)
    api.stroke({ color: drawing.color, width: drawing.width, points: drawing.points })
  }
  drawing = null
}

canvas.addEventListener('pointerup', finishStroke)
canvas.addEventListener('pointercancel', finishStroke)
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.exit()
})
window.addEventListener('resize', resize)

api.onConfigure((raw) => {
  if (!raw || typeof raw !== 'object') return
  const payload = raw as { enabled?: unknown; color?: unknown; width?: unknown }
  if (typeof payload.enabled === 'boolean') enabled = payload.enabled
  if (typeof payload.color === 'string' && payload.color in colors) color = payload.color as InkColor
  if (typeof payload.width === 'number' && Number.isFinite(payload.width)) {
    width = Math.max(2, Math.min(18, payload.width))
  }
  document.body.dataset.enabled = String(enabled)
  if (!enabled) finishStroke()
})
api.onClear(() => { strokes = []; drawing = null })
api.onReset(() => { enabled = false; strokes = []; drawing = null })

resize()
requestAnimationFrame(render)
})()
