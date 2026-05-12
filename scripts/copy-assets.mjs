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
]

await fs.mkdir(path.join(root, 'dist/recorder'), { recursive: true })
await fs.mkdir(path.join(root, 'dist/overlay'), { recursive: true })

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
