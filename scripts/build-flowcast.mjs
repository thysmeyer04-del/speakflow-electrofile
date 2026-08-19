import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const nativeRoot = path.join(projectRoot, 'native')
const recorderRoot = path.join(nativeRoot, 'flowcast-recorder')
const outputRoot = path.join(nativeRoot, 'bin')
const stagingRoot = path.join(nativeRoot, '.staging')
const cargoTarget = path.join(nativeRoot, '.target')
const cacheRoot = path.join(nativeRoot, 'cache')

const FFMPEG_TAG = 'autobuild-2026-08-19-19-21'
const FFMPEG_ASSET = 'ffmpeg-n8.1.2-44-g7c533d0f86-win64-lgpl-shared-8.1.zip'
const FFMPEG_SHA256 = 'ca4a681e0511d2da95921029ff5f9c3e898a36d5114b2b06bba9cc4e73354300'
const FFMPEG_URL =
  `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_TAG}/${FFMPEG_ASSET}`

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, bytes)
  fs.renameSync(temporary, target)
}

function findFile(root, filename) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return candidate
    if (entry.isDirectory()) {
      const found = findFile(candidate, filename)
      if (found) return found
    }
  }
  return null
}

function copyDirectoryFiles(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile()) fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name))
  }
}

function writeNotice(target) {
  fs.writeFileSync(
    target,
    [
      'Speakflow Flowcast FFmpeg runtime',
      '',
      `Build: ${FFMPEG_ASSET}`,
      `Release: ${FFMPEG_TAG}`,
      `SHA-256: ${FFMPEG_SHA256}`,
      `Binary source: ${FFMPEG_URL}`,
      'Upstream source and build scripts: https://github.com/BtbN/FFmpeg-Builds',
      'FFmpeg source: https://ffmpeg.org/download.html',
      '',
      'This is the LGPL shared build. Speakflow invokes the unmodified shared',
      'runtime as a separate process and does not bundle a GPL FFmpeg build.',
      'See LICENSE.txt in this folder for the included license terms.',
      '',
    ].join('\n'),
  )
}

async function main() {
  fs.rmSync(stagingRoot, { recursive: true, force: true })
  fs.mkdirSync(stagingRoot, { recursive: true })

  if (process.platform !== 'win32') {
    fs.rmSync(outputRoot, { recursive: true, force: true })
    fs.mkdirSync(outputRoot, { recursive: true })
    fs.writeFileSync(
      path.join(outputRoot, 'FLOWCAST-WINDOWS-ONLY.txt'),
      'Flowcast native capture is currently packaged only for Windows.\n',
    )
    return
  }

  run('cargo', ['build', '--release', '--locked', '-j', '1'], {
    cwd: recorderRoot,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: cargoTarget,
      CARGO_INCREMENTAL: '0',
    },
  })

  const archive = path.join(cacheRoot, FFMPEG_ASSET)
  if (!fs.existsSync(archive) || sha256(archive) !== FFMPEG_SHA256) {
    fs.rmSync(archive, { force: true })
    console.log(`[flowcast] downloading pinned LGPL FFmpeg ${FFMPEG_TAG}`)
    await download(FFMPEG_URL, archive)
  }
  const actualHash = sha256(archive)
  if (actualHash !== FFMPEG_SHA256) {
    throw new Error(`FFmpeg checksum mismatch: expected ${FFMPEG_SHA256}, got ${actualHash}`)
  }

  const extracted = path.join(stagingRoot, 'extracted')
  run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:FLOWCAST_ARCHIVE -DestinationPath $env:FLOWCAST_EXTRACTED -Force',
    ],
    {
      cwd: nativeRoot,
      env: {
        ...process.env,
        FLOWCAST_ARCHIVE: archive,
        FLOWCAST_EXTRACTED: extracted,
      },
    },
  )

  const ffmpegExe = findFile(extracted, 'ffmpeg.exe')
  const ffprobeExe = findFile(extracted, 'ffprobe.exe')
  const license = findFile(extracted, 'LICENSE.txt')
  if (!ffmpegExe || !ffprobeExe || !license) {
    throw new Error('the pinned archive is missing ffmpeg.exe, ffprobe.exe, or LICENSE.txt')
  }

  const packaged = path.join(stagingRoot, 'package')
  const runtime = path.join(packaged, 'ffmpeg')
  copyDirectoryFiles(path.dirname(ffmpegExe), runtime)
  fs.copyFileSync(license, path.join(runtime, 'LICENSE.txt'))
  writeNotice(path.join(runtime, 'SPEAKFLOW-FFMPEG-NOTICE.txt'))

  const recorderExe = path.join(cargoTarget, 'release', 'flowcast-recorder.exe')
  if (!fs.existsSync(recorderExe)) throw new Error('cargo did not produce flowcast-recorder.exe')
  fs.copyFileSync(recorderExe, path.join(packaged, 'flowcast-recorder.exe'))

  run(path.join(runtime, 'ffmpeg.exe'), ['-version'], { cwd: runtime })
  run(path.join(runtime, 'ffprobe.exe'), ['-version'], { cwd: runtime })

  fs.rmSync(outputRoot, { recursive: true, force: true })
  fs.renameSync(packaged, outputRoot)
  fs.rmSync(stagingRoot, { recursive: true, force: true })
  console.log(`[flowcast] packaged recorder and verified LGPL runtime in ${outputRoot}`)
}

main().catch((error) => {
  console.error(`[flowcast] build failed: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
