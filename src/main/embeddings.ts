// Local embedding via @xenova/transformers (Xenova/all-MiniLM-L6-v2, 384-dim).
//
// CRITICAL: @xenova/transformers is ESM-only, but this project compiles to
// CommonJS (`module: "CommonJS"` in tsconfig). TypeScript would normally
// compile `import { pipeline } from '@xenova/transformers'` into
// `require('@xenova/transformers')`, which Node refuses with:
//   "require() of ES Module ... not supported"
//
// Even `await import('@xenova/transformers')` gets rewritten by TS to
// `Promise.resolve(require(...))` under CommonJS — same crash.
//
// The Function-constructor trick below opaquely creates a real ECMAScript
// `import(...)` expression that TypeScript can't see and therefore can't
// rewrite. Node then resolves it as a true dynamic import, which works for
// ESM modules from CJS.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const importTransformers: () => Promise<any> = new Function(
  'return import("@xenova/transformers")',
) as () => Promise<any>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineFn: any = null

/**
 * Initializes the embedding pipeline if not already loaded.
 * Uses the all-MiniLM-L6-v2 model (384 dimensions).
 */
export const getEmbedder = async () => {
  if (!embedder) {
    if (!pipelineFn) {
      const transformers = await importTransformers()
      pipelineFn = transformers.pipeline
    }
    embedder = await pipelineFn(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
    )
  }
  return embedder
}

/**
 * Generates a 384-dimension vector for a given text string.
 */
export const generateEmbedding = async (text: string): Promise<number[]> => {
  const generate = await getEmbedder()
  const output = await generate(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data) as number[]
}
