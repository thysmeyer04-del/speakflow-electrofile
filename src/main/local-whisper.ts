// On-device Whisper transcription via @xenova/transformers (ONNX, CPU).
//
// Input is raw 16 kHz mono Float32 PCM decoded by the recorder renderer —
// the main process never needs an audio decoder. The model is downloaded
// from HuggingFace on first use and cached under userData/models, after
// which transcription is fully offline.
//
// Same ESM-from-CJS constraint as embeddings.ts: @xenova/transformers is
// ESM-only, so the import must be an opaque dynamic import TypeScript
// cannot rewrite into require().

import { app, BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'
import log from 'electron-log/main'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const importTransformers: () => Promise<any> = new Function(
  'return import("@xenova/transformers")',
) as () => Promise<any>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transcriber: any = null
let loadedModel: string | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadPromise: Promise<any> | null = null

function modelCacheDir(): string {
  return path.join(app.getPath('userData'), 'models')
}

/** True once the model files exist on disk (i.e. offline use is possible). */
export function isLocalModelCached(model: string): boolean {
  if (loadedModel === model && transcriber) return true
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTranscriber(model: string): Promise<any> {
  if (transcriber && loadedModel === model) return transcriber
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    const t0 = Date.now()
    const transformers = await importTransformers()
    transformers.env.cacheDir = modelCacheDir()
    transformers.env.allowLocalModels = false

    const firstDownload = !isLocalModelCached(model)
    if (firstDownload) {
      log.info(`[local-whisper] downloading ${model} (first run, one-off)`)
      broadcastStatus('Downloading Whisper model (one-off)…')
    }

    let lastPct = -1
    const pipe = await transformers.pipeline('automatic-speech-recognition', model, {
      // quantized (default true) keeps whisper-medium around ~0.8 GB on disk.
      progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
        if (firstDownload && p.status === 'progress' && typeof p.progress === 'number') {
          const pct = Math.floor(p.progress)
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct
            broadcastStatus(`Downloading Whisper model… ${pct}%`)
          }
        }
      },
    })
    transcriber = pipe
    loadedModel = model
    log.info(`[timing] local whisper ${model} loaded in ${Date.now() - t0}ms`)
    return pipe
  })().finally(() => {
    loadPromise = null
  })
  return loadPromise
}

/** Fire-and-forget preload so the first dictation doesn't pay model-load cost. */
export function warmupLocalWhisper(model: string): void {
  getTranscriber(model).catch((err) =>
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
  const pipe = await getTranscriber(model)
  const t0 = Date.now()
  const audioSeconds = pcm.length / 16_000
  // .en model variants are English-only and reject language/task options.
  const multilingual = !model.endsWith('.en')
  const result = await pipe(pcm, {
    chunk_length_s: 30,
    stride_length_s: 5,
    ...(multilingual
      ? { language: opts.language, task: 'transcribe' }
      : {}),
  })
  const text: string = (result?.text ?? '').trim()
  log.info(
    `[timing] local whisper transcribed ${audioSeconds.toFixed(1)}s audio in ${Date.now() - t0}ms (${model})`,
  )
  return text
}
