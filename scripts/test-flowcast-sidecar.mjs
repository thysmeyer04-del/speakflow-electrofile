import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const root = process.cwd()
const outputRoot = path.resolve(process.argv[2] ?? path.join(root, '.tmp-flowcast-sidecar'))
const recorder = path.join(root, 'native', 'bin', 'flowcast-recorder.exe')
const runtime = path.join(root, 'native', 'bin', 'ffmpeg')
const ffmpeg = path.join(runtime, 'ffmpeg.exe')
const ffprobe = path.join(runtime, 'ffprobe.exe')
const sessionRoot = path.join(outputRoot, 'session')

fs.mkdirSync(sessionRoot, { recursive: true })

const child = spawn(recorder, [], {
  cwd: root,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, FLOWCAST_FFMPEG_DIR: runtime },
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

const events = []
const waiters = new Set()
const lines = readline.createInterface({ input: child.stdout })
lines.on('line', (line) => {
  const event = JSON.parse(line)
  events.push(event)
  process.stdout.write(`${JSON.stringify(event)}\n`)
  for (const waiter of [...waiters]) {
    if (!waiter.predicate(event)) continue
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    waiter.resolve(event)
  }
})

function waitFor(predicate, timeoutMs = 15_000) {
  const existing = events.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        waiters.delete(waiter)
        reject(new Error('Timed out waiting for the recorder event.'))
      }, timeoutMs),
    }
    waiters.add(waiter)
  })
}

function send(command) {
  child.stdin.write(`${JSON.stringify({ v: 2, ...command })}\n`)
}

try {
  const readyWait = waitFor((event) => event.ev === 'ready' && event.id === 1)
  send({ cmd: 'probe', id: 1 })
  const ready = await readyWait
  const target = ready.caps.windows.find((item) =>
    String(item.process_name).toLowerCase() === 'explorer.exe',
  ) ?? ready.caps.windows[0]
  if (!target) throw new Error('No capturable window was reported.')

  const startedWait = waitFor((event) => event.ev === 'started' && event.id === 2)
  send({
    cmd: 'start',
    id: 2,
    session: 'window-overlay-smoke',
    out_dir: sessionRoot,
    source: { kind: 'window', index: target.index },
    video: { width: 1920, height: 1080, fps: 30, bitrate: 1_050_000 },
    audio: { mic: false, system: false, bitrate: 96_000 },
    cursor: true,
    click_highlight: false,
    parent_pid: process.pid,
  })
  await startedWait

  const cameraJpeg = path.join(outputRoot, 'camera-test.jpg')
  const camera = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x2463eb:s=360x360:d=0.1',
    '-frames:v', '1', cameraJpeg,
  ], { windowsHide: true, encoding: 'utf8' })
  if (camera.status !== 0) throw new Error(`Could not create camera fixture: ${camera.stderr}`)

  send({ cmd: 'camera_layout', id: 3, visible: true, x: 0.82, y: 0.78, size: 'medium' })
  send({ cmd: 'camera_frame', id: 4, data: fs.readFileSync(cameraJpeg).toString('base64') })
  send({
    cmd: 'draw_stroke',
    id: 5,
    color: 'green',
    width: 12,
    points: [
      { x: 0.08, y: 0.14 },
      { x: 0.30, y: 0.28 },
      { x: 0.52, y: 0.14 },
    ],
  })

  await new Promise((resolve) => setTimeout(resolve, 3_500))
  const stoppedWait = waitFor((event) => event.ev === 'stopped' && event.id === 6, 45_000)
  send({ cmd: 'stop', id: 6 })
  const stopped = await stoppedWait
  child.stdin.end()
  await new Promise((resolve) => child.once('exit', resolve))

  const screenshot = path.join(outputRoot, 'window-overlay.png')
  const frame = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-ss', '2',
    '-i', stopped.file, '-frames:v', '1', screenshot,
  ], { windowsHide: true, encoding: 'utf8' })
  if (frame.status !== 0) throw new Error(`Could not extract verification frame: ${frame.stderr}`)

  const inspection = spawnSync(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration,size',
    '-show_entries', 'stream=codec_name,codec_type,width,height,r_frame_rate',
    '-of', 'json', stopped.file,
  ], { windowsHide: true, encoding: 'utf8' })
  if (inspection.status !== 0) throw new Error(`ffprobe failed: ${inspection.stderr}`)
  process.stdout.write(`${inspection.stdout.trim()}\n`)
  process.stdout.write(`verification_frame=${screenshot}\n`)
} catch (error) {
  child.stdin.end()
  throw error
}
