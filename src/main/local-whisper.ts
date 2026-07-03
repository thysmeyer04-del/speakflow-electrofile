// On-device Whisper transcription — parent-side manager.
//
// The actual model runs in an isolated utilityProcess (see
// local-whisper-worker.ts): onnxruntime inference can hard-crash at the
// native level, and in-process that killed the whole app mid-dictation.
// Here a worker crash only rejects the in-flight requests — callers fall
// back to cloud — and after MAX_CRASHES the app auto-reverts the
// transcriptionMode setting to 'cloud' so a machine that can't run the
// model never degrades the dictation experience.
//
// The model downloads from HuggingFace on first use and is cached under
// userData/models, after which transcription is fully offline.

import { app, BrowserWindow, utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import path from 'path'
import fs from 'fs'
import log from 'electron-log/main'
import { setSetting } from './settings'

const MAX_CRASHES = 2
const LOAD_TIMEOUT_MS = 15 * 60_000 // generous: covers the one-off download
const TRANSCRIBE_TIMEOUT_MS = 180_000

let worker: UtilityProcess | null = null
let workerModel: string | null = null
let workerReady: Promise<void> | null = null
let crashCount = 0
let seq = 0

interface PendingRequest {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}
const pending = new Map<number, PendingRequest>()

function modelCacheDir(): string {
  return path.join(app.getPath('userData'), 'models')
}

/** True once the model files exist on disk (i.e. offline use is possible). */
export function isLocalModelCached(model: string): boolean {
  try {
    return fs.existsSync(path.join(modelCacheDir(), ...model.split('/')))
  } catch {
    return false
  }
}

function broadcastStatus(message: string): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('transcription-status', message)
  })
}

function handleWorkerExit(code: number): void {
  const inFlight = pending.size
  log.error(`[local-whisper] worker exited (code ${code}) with ${inFlight} in-flight request(s)`)
  for (const [, p] of pending) {
    clearTimeout(p.timer)
    p.reject(new Error('local-whisper-worker-crashed'))
  }
  pending.clear()
  worker = null
  workerModel = null
  workerReady = null
  crashCount++
  if (crashCount >= MAX_CRASHES) {
    log.error('[local-whisper] repeated worker crashes — reverting transcriptionMode to cloud')
    broadcastStatus('Local Whisper keeps failing on this machine — switched back to cloud.')
    try {
      setSetting('transcriptionMode', 'cloud')
    } catch (err) {
      log.warn('[local-whisper] failed to revert transcriptionMode', err)
    }
  }
}

function ensureWorker(model: string): Promise<void> {
  if (worker && workerModel === model && workerReady) return workerReady
  if (crashCount >= MAX_CRASHES) {
    return Promise.reject(new Error('local-whisper-disabled-after-crashes'))
  }
  if (worker) {
    try {
      worker.kill()
    } catch {
      // already gone
    }
    worker = null
  }

  workerModel = model
  const child = utilityProcess.fork(
    path.join(__dirname, 'local-whisper-worker.js'),
    [],
    { serviceName: 'speakflow-local-whisper' },
  )
  worker = child

  workerReady = new Promise<void>((resolve, reject) => {
    const loadTimer = setTimeout(() => {
      reject(new Error('local-whisper-load-timeout'))
      try {
        child.kill()
      } catch {
        // best effort
      }
    }, LOAD_TIMEOUT_MS)

    child.on('message', (msg: unknown) => {
      const m = msg as {
        type?: string
        message?: string
        ms?: number
        id?: number
        text?: string
      }
      if (!m || typeof m !== 'object') return
      switch (m.type) {
        case 'status':
          if (typeof m.message === 'string') broadcastStatus(m.message)
          break
        case 'loaded':
          clearTimeout(loadTimer)
          log.info(`[timing] local whisper ${model} loaded in worker in ${m.ms}ms`)
          resolve()
          break
        case 'load-error':
          clearTimeout(loadTimer)
          log.warn(`[local-whisper] load failed: ${m.message}`)
          reject(new Error(m.message || 'local-whisper-load-failed'))
          break
        case 'result': {
          const p = typeof m.id === 'number' ? pending.get(m.id) : undefined
          if (p && typeof m.id === 'number') {
            clearTimeout(p.timer)
            pending.delete(m.id)
            p.resolve(m.text ?? '')
          }
          break
        }
        case 'error': {
          const p = typeof m.id === 'number' ? pending.get(m.id) : undefined
          if (p && typeof m.id === 'number') {
            clearTimeout(p.timer)
            pending.delete(m.id)
            p.reject(new Error(m.message || 'local-whisper-transcribe-failed'))
          }
          break
        }
      }
    })

    child.on('exit', (code) => {
      clearTimeout(loadTimer)
      handleWorkerExit(code)
      reject(new Error('local-whisper-worker-crashed'))
    })

    child.postMessage({
      type: 'load',
      model,
      cacheDir: modelCacheDir(),
      firstDownload: !isLocalModelCached(model),
    })
  })
  return workerReady
}

/** Fire-and-forget preload so the first dictation doesn't pay model-load cost. */
export function warmupLocalWhisper(model: string): void {
  ensureWorker(model).catch((err) =>
    log.warn('[local-whisper] warmup failed (will retry on first use)', err),
  )
}

interface LocalTranscribeOptions {
  language?: string // ISO code like 'en'; undefined = auto-detect
}

export async function transcribeLocal(
  pcm: Float32Array,
  model: string,
  opts: LocalTranscribeOptions = {},
): Promise<string> {
  await ensureWorker(model)
  const w = worker
  if (!w) throw new Error('local-whisper-worker-missing')

  const id = ++seq
  const t0 = Date.now()
  const audioSeconds = pcm.length / 16_000

  const text = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('local-whisper-timeout'))
    }, TRANSCRIBE_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    w.postMessage({
      type: 'transcribe',
      id,
      pcm,
      language: opts.language,
      // .en model variants are English-only and reject language/task options.
      multilingual: !model.endsWith('.en'),
    })
  })

  log.info(
    `[timing] local whisper transcribed ${audioSeconds.toFixed(1)}s audio in ${Date.now() - t0}ms (${model})`,
  )
  return text.trim()
}
