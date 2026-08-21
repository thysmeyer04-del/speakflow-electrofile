(() => {
interface CameraBridge {
  sendFrame(frame: Uint8Array): void
  ready(): void
  error(message: string): void
  onStart(callback: () => void): () => void
  onStop(callback: () => void): () => void
}

const api = (window as unknown as { flowcastCamera: CameraBridge }).flowcastCamera
const video = document.querySelector<HTMLVideoElement>('video')!
const canvas = document.createElement('canvas')
canvas.width = 360
canvas.height = 360
const context = canvas.getContext('2d', { alpha: false })!

let stream: MediaStream | null = null
let timer: number | null = null
let encoding = false

async function start(): Promise<void> {
  if (stream) {
    api.ready()
    return
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 15, max: 20 },
      },
      audio: false,
    })
    video.srcObject = stream
    await video.play()
    document.body.dataset.ready = 'true'
    api.ready()
    timer = window.setInterval(() => void captureFrame(), 83)
  } catch (error) {
    stop()
    api.error(error instanceof Error ? error.message : 'Camera permission was denied.')
  }
}

function stop(): void {
  if (timer !== null) window.clearInterval(timer)
  timer = null
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  video.srcObject = null
  document.body.dataset.ready = 'false'
}

async function captureFrame(): Promise<void> {
  if (!stream || encoding || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
  encoding = true
  try {
    const sourceWidth = video.videoWidth
    const sourceHeight = video.videoHeight
    const side = Math.min(sourceWidth, sourceHeight)
    const sourceX = Math.max(0, (sourceWidth - side) / 2)
    const sourceY = Math.max(0, (sourceHeight - side) / 2)
    context.drawImage(video, sourceX, sourceY, side, side, 0, 0, 360, 360)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.74),
    )
    if (!blob || blob.size > 500_000) return
    api.sendFrame(new Uint8Array(await blob.arrayBuffer()))
  } finally {
    encoding = false
  }
}

api.onStart(() => void start())
api.onStop(stop)
window.addEventListener('beforeunload', stop)
})()
