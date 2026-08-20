#!/usr/bin/env node
// Copy HTML files referenced by the main process into dist/ so loadFile() resolves.
// Also stages overlay.js / recorder.js next to their .html files.

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const pairs = [
  { src: 'src/recorder/recorder.html', dst: 'dist/recorder/recorder.html' },
  { src: 'src/overlay/overlay.html',   dst: 'dist/overlay/overlay.html' },
  { src: 'src/flowcast-control/flowcast-control.html', dst: 'dist/flowcast-control/flowcast-control.html' },
  // AudioWorklet module for True Streaming: plain JS (worklet scopes can't be
  // produced by this tsc build), loaded at runtime relative to recorder.html
  // via audioWorklet.addModule('pcm-worklet.js') — must sit beside it in dist.
  { src: 'src/recorder/pcm-worklet.js', dst: 'dist/recorder/pcm-worklet.js' },
]

await fs.mkdir(path.join(root, 'dist/recorder'), { recursive: true })
await fs.mkdir(path.join(root, 'dist/overlay'), { recursive: true })
await fs.mkdir(path.join(root, 'dist/flowcast-control'), { recursive: true })
await fs.mkdir(path.join(root, 'dist/preload'), { recursive: true })

for (const { src, dst } of pairs) {
  const from = path.join(root, src)
  const to = path.join(root, dst)
  try {
    await fs.copyFile(from, to)
    console.log(`copied ${src} → ${dst}`)
  } catch (err) {
    console.error(`failed to copy ${src}: ${err.message}`)
    process.exit(1)
  }
}
