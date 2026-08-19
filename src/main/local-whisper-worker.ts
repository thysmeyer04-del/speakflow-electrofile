// Isolated inference worker for on-device Whisper.
//
// Runs @huggingface/transformers (onnxruntime native code) in an Electron
// utilityProcess. Rationale: onnxruntime inference can hard-crash at the
// native level — nothing catchable in JS. In-process that killed the whole
// app mid-dictation; in a worker it kills only this process, and the parent
// falls back to cloud transcription.
//
// Protocol (parent ⇄ worker over parentPort):
//   → { type: 'load', model, cacheDir, firstDownload }
//   ← { type: 'status', message }            // download progress etc.
//   ← { type: 'loaded', ms } | { type: 'load-error', message }
//   → { type: 'transcribe', id, pcm: Float32Array, language?, multilingual }
//   ← { type: 'result', id, text } | { type: 'error', id, message }
//
// Same ESM-from-CJS constraint as elsewhere: the import must be an opaque
// dynamic import TypeScript cannot rewrite into require().

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const importTransformers: () => Promise<any> = new Function(
  'return import("@huggingface/transformers")',
) as () => Promise<any>

interface ParentPort {
  on(event: 'message', cb: (e: { data: unknown }) => void): void
  postMessage(message: unknown): void
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipe: any = null

function send(message: unknown): void {
  try {
    parentPort.postMessage(message)
  } catch {
    // parent gone — nothing useful to do
  }
}

interface LoadMsg {
  type: 'load'
  model: string
  cacheDir: string
  firstDownload: boolean
}
interface TranscribeMsg {
  type: 'transcribe'
  id: number
  pcm: Float32Array
  language?: string
  multilingual: boolean
}

async function handleLoad(msg: LoadMsg): Promise<void> {
  const t0 = Date.now()
  try {
    const transformers = await importTransformers()
    transformers.env.cacheDir = msg.cacheDir
    transformers.env.allowLocalModels = false

    if (msg.firstDownload) {
      send({ type: 'status', message: 'Downloading Whisper model (one-off)…' })
    }
    let lastPct = -1
    pipe = await transformers.pipeline('automatic-speech-recognition', msg.model, {
      progress_callback: (p: { status?: string; progress?: number }) => {
        if (msg.firstDownload && p.status === 'progress' && typeof p.progress === 'number') {
          const pct = Math.floor(p.progress)
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct
            send({ type: 'status', message: `Downloading Whisper model… ${pct}%` })
          }
        }
      },
    })
    send({ type: 'loaded', ms: Date.now() - t0 })
  } catch (err) {
    send({ type: 'load-error', message: (err as Error).message || 'load-failed' })
  }
}

async function handleTranscribe(msg: TranscribeMsg): Promise<void> {
  try {
    if (!pipe) throw new Error('model-not-loaded')
    const result = await pipe(msg.pcm, {
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(msg.multilingual ? { language: msg.language, task: 'transcribe' } : {}),
    })
    send({ type: 'result', id: msg.id, text: result?.text ?? '' })
  } catch (err) {
    send({ type: 'error', id: msg.id, message: (err as Error).message || 'transcribe-failed' })
  }
}

// Serialize transcriptions: concurrent generate() calls on one pipeline are
// not guaranteed safe, and they'd fight over the same CPU cores anyway.
let chain: Promise<void> = Promise.resolve()

parentPort.on('message', (e) => {
  const msg = e.data as LoadMsg | TranscribeMsg | undefined
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'load') {
    chain = chain.then(() => handleLoad(msg))
  } else if (msg.type === 'transcribe') {
    chain = chain.then(() => handleTranscribe(msg))
  }
})
