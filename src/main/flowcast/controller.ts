// Ties the recorder, the session folder and the uploader together, and owns
// the "am I recording?" state.
//
// Modelled on the existing recording-controller.ts: one state machine, all
// operations queued behind a single promise chain so a stop that arrives while
// a start is still in flight cannot interleave.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, clipboard } from 'electron'
import log from 'electron-log/main'

import { Sidecar } from './sidecar'
import { uploadRecording } from './uploader'
import type { Caps, SessionManifest } from './types'
import type { CameraSize, InkColor, OverlayPoint } from './types'
import { preflightRecording } from './api'
import { releaseMedia, tryAcquireMedia } from '../media-owner'
import { getAuthContext } from '../ipc'
import { exportFinalizedRecording, resolveLocalExportDirectory } from './local-export'

export type FlowcastState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'saving' | 'uploading'
export type FlowcastStorageMode = 'local' | 'cloud'

export interface FlowcastCompletion {
  storageMode: FlowcastStorageMode
  location: string
}

export interface FlowcastOptions {
  captureMic: boolean
  captureSystemAudio: boolean
  quality: 'balanced' | 'high'
  monitorIndex?: number
  source?: { kind: 'monitor'; index?: number } | { kind: 'window'; index: number }
  cursor: boolean
  clickHighlight: boolean
  cameraEnabled?: boolean
  cameraSize?: CameraSize
  cameraX?: number
  cameraY?: number
  visibility: 'private' | 'unlisted'
  storageMode: FlowcastStorageMode
  exportDirectory?: string
}

export interface FlowcastEvents {
  onState?: (state: FlowcastState, detail?: { elapsedMs?: number; percent?: number }) => void
  onWarn?: (message: string) => void
  onDone?: (result: FlowcastCompletion) => void
  onError?: (message: string) => void
}

/** 'balanced' targets about 45 MB for five minutes, which is the size budget.
 *  'high' roughly doubles it and is off by default. */
const QUALITY = {
  balanced: { bitrate: 1_050_000, fps: 30 },
  high: { bitrate: 2_500_000, fps: 30 },
} as const

/** Refuse to start below this. Running out of disk halfway through is a lost
 *  recording, and the person will not find out until they stop. */
const MIN_FREE_MB = 2_048
const LOCAL_MAX_DURATION_SECONDS = 2 * 60 * 60
const LOCAL_MANIFEST_OWNER = 'local-flowcast'

export class FlowcastController {
  private sidecar: Sidecar
  private state: FlowcastState = 'idle'
  private manifest: SessionManifest | null = null
  private startedAt = 0
  private pausedAt = 0
  private totalPausedMs = 0
  private caps: Caps | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private maximumTimer: NodeJS.Timeout | null = null
  private recoveryPromise: Promise<number> | null = null
  private activeStorageMode: FlowcastStorageMode = 'local'
  private activeExportDirectory: string | null = null
  private lastCompletion: FlowcastCompletion | null = null
  private activeOptions: FlowcastOptions | null = null

  constructor(private events: FlowcastEvents = {}) {
    this.sidecar = new Sidecar({
      onWarn: (code, message) => {
        // Audio failures land here. The recording is still going, and saying
        // so plainly is better than a silent surprise at the end.
        if (code === 'audio_unavailable') {
          this.events.onWarn?.('Recording without sound — the microphone could not be opened.')
        } else {
          this.events.onWarn?.(message)
        }
      },
      onError: (_code, message, fatal) => {
        if (fatal) {
          this.setState('idle')
          this.events.onError?.(message)
        }
      },
    })
  }

  getState(): FlowcastState {
    return this.state
  }

  elapsedMs(): number {
    if (!this.startedAt) return 0
    const end = this.pausedAt || Date.now()
    return Math.max(0, end - this.startedAt - this.totalPausedMs)
  }

  getLastCompletion(): FlowcastCompletion | null {
    return this.lastCompletion
  }

  getCapabilities(): Caps | null {
    return this.caps
  }

  getActiveOptions(): FlowcastOptions | null {
    return this.activeOptions
  }

  getActiveCaptureBounds(): { x: number; y: number; width: number; height: number } | null {
    const options = this.activeOptions
    const caps = this.caps
    if (!options || !caps) return null
    const source = options.source ?? { kind: 'monitor' as const, index: options.monitorIndex }
    const found = source.kind === 'window'
      ? caps.windows.find((item) => item.index === source.index)
      : caps.monitors.find((item) => item.index === (source.index ?? 0)) ?? caps.monitors[0]
    return found
      ? { x: found.x, y: found.y, width: found.width, height: found.height }
      : null
  }

  setCameraLayout(visible: boolean, x: number, y: number, size: CameraSize): void {
    if (this.state !== 'recording' && this.state !== 'paused') return
    this.sidecar.setCameraLayout(visible, x, y, size)
  }

  setCameraFrame(jpeg: Uint8Array): void {
    if (this.state !== 'recording') return
    this.sidecar.setCameraFrame(jpeg)
  }

  addStroke(color: InkColor, width: number, points: OverlayPoint[]): void {
    if (this.state !== 'recording' && this.state !== 'paused') return
    this.sidecar.addStroke(color, width, points)
  }

  clearInk(): void {
    if (this.state !== 'recording' && this.state !== 'paused') return
    this.sidecar.clearInk()
  }

  resolveExportDirectory(configuredDirectory?: string): string | null {
    return resolveLocalExportDirectory(configuredDirectory)
  }

  /** Check the machine can do this at all, once at startup.
   *
   *  Returns null when Flowcast should stay switched off — the most likely
   *  reason is Windows N or KN, which ships no H.264 encoder. Far better to
   *  find out here than halfway through someone's first recording. */
  async checkCapabilities(): Promise<Caps | null> {
    try {
      this.caps = await this.sidecar.probe()
      if (!this.caps.h264_available) {
        log.warn(`[flowcast] no H.264 encoder: ${this.caps.h264_error ?? 'unknown reason'}`)
        return null
      }
      return this.caps
    } catch (error) {
      log.warn('[flowcast] the recorder could not be started', error)
      return null
    }
  }

  start(options: FlowcastOptions): Promise<void> {
    return this.queue(async () => {
      if (this.state !== 'idle') return
      if (process.platform !== 'win32') throw new Error('Flowcast is currently available on Windows only.')
      if (!tryAcquireMedia('flowcast')) {
        throw new Error('Stop dictation before starting a screen recording.')
      }
      this.setState('starting')

      try {
        const caps = this.caps ?? (await this.checkCapabilities())
        if (!caps?.h264_available) {
          throw new Error(caps?.h264_error ?? 'Screen recording is unavailable on this computer.')
        }

        const storageMode: FlowcastStorageMode =
          options.storageMode === 'cloud' ? 'cloud' : 'local'
        let ownerId = LOCAL_MANIFEST_OWNER
        let maximumSeconds = LOCAL_MAX_DURATION_SECONDS
        let exportDirectory: string | null = null

        if (storageMode === 'cloud') {
          const auth = getAuthContext()
          if (!auth) throw new Error('Please sign in before starting a screen recording.')
          const preflight = await preflightRecording()
          if (!preflight.enabled) {
            throw new Error(preflight.reason ?? 'Screen recording is not enabled for this account yet.')
          }
          if (getAuthContext()?.ownerId !== auth.ownerId) {
            throw new Error('The signed-in account changed while Flowcast was starting.')
          }
          ownerId = auth.ownerId
          maximumSeconds = Math.max(1, preflight.maxDurationSeconds)
        } else {
          exportDirectory = this.resolveExportDirectory(options.exportDirectory)
          if (!exportDirectory) {
            throw new Error(
              'Choose a save folder in Settings → Flowcast before recording.',
            )
          }
          await fs.promises.mkdir(exportDirectory, { recursive: true })
          const exportFreeMb = await freeSpaceMb(exportDirectory)
          if (exportFreeMb !== null && exportFreeMb < MIN_FREE_MB) {
            throw new Error(
              `Not enough space in the selected save folder — ${Math.round(exportFreeMb / 1024)} GB free. About 2 GB is needed.`,
            )
          }
        }

        const sessionId = randomUUID()
        const dir = path.join(app.getPath('userData'), 'flowcast', sessionId)
        await fs.promises.mkdir(dir, { recursive: true })

        const freeMb = await freeSpaceMb(dir)
        if (freeMb !== null && freeMb < MIN_FREE_MB) {
          throw new Error(
            `Not enough space to record — ${Math.round(freeMb / 1024)} GB free. About 2 GB is needed.`,
          )
        }

        const quality = QUALITY[options.quality] ?? QUALITY.balanced

        const started = await this.sidecar.startRecording({
          session: sessionId,
          out_dir: dir,
          source: options.source ?? { kind: 'monitor', index: options.monitorIndex },
          // The recorder fits these to the actual screen, so a 4K display comes
          // out at 1080p rather than four times the size.
          video: { width: 1920, height: 1080, fps: quality.fps, bitrate: quality.bitrate },
          audio: {
            mic: options.captureMic,
            system: options.captureSystemAudio,
            bitrate: 96_000,
          },
          click_highlight: options.clickHighlight,
          cursor: options.cursor,
        })

        this.startedAt = Date.now()
        this.pausedAt = 0
        this.totalPausedMs = 0
        this.manifest = {
          v: 1,
          sessionId,
          ownerId,
          destination: storageMode,
          state: 'recording',
          createdAtUnixMs: this.startedAt,
          file: path.join(dir, 'recording.mp4'),
          bytes: 0,
          durationMs: 0,
          width: started.width,
          height: started.height,
          visibility: options.visibility,
          localExportDirectory: exportDirectory ?? undefined,
        }
        await this.writeManifest()
        this.activeStorageMode = storageMode
        this.activeExportDirectory = exportDirectory
        this.activeOptions = {
          ...options,
          cameraSize: options.cameraSize ?? 'small',
          cameraX: Math.max(0, Math.min(1, options.cameraX ?? 0.14)),
          cameraY: Math.max(0, Math.min(1, options.cameraY ?? 0.82)),
        }
        this.lastCompletion = null
        this.setState('recording')
        this.maximumTimer = setTimeout(() => {
          this.events.onWarn?.('The maximum recording length was reached. Saving your recording now.')
          void this.stop()
        }, maximumSeconds * 1_000)
        this.maximumTimer.unref?.()
      } catch (error) {
        this.activeExportDirectory = null
        this.setState('idle')
        throw error
      }
    })
  }

  pause(): Promise<void> {
    return this.queue(async () => {
      if (this.state !== 'recording') return
      await this.sidecar.pauseRecording(true)
      this.pausedAt = Date.now()
      this.setState('paused')
    })
  }

  resume(): Promise<void> {
    return this.queue(async () => {
      if (this.state !== 'paused') return
      await this.sidecar.pauseRecording(false)
      if (this.pausedAt) this.totalPausedMs += Date.now() - this.pausedAt
      this.pausedAt = 0
      this.setState('recording')
    })
  }

  stop(discard = false): Promise<FlowcastCompletion | null> {
    return this.queue(async () => {
      if (this.state !== 'recording' && this.state !== 'paused') return null
      if (this.pausedAt) {
        this.totalPausedMs += Date.now() - this.pausedAt
        this.pausedAt = 0
      }
      this.setState('stopping')
      if (this.maximumTimer) {
        clearTimeout(this.maximumTimer)
        this.maximumTimer = null
      }

      const manifest = this.manifest
      try {
        const stopped = await this.sidecar.stopRecording(discard)

        if (discard || !manifest) {
          await this.cleanupSession()
          this.setState('idle')
          return null
        }

        manifest.state = 'stopped'
        manifest.bytes = stopped.bytes
        manifest.durationMs = stopped.duration_ms
        if (stopped.file) manifest.file = stopped.file
        await this.writeManifest()

        if (this.activeStorageMode === 'local') {
          this.setState('saving')
          const exportDirectory =
            this.activeExportDirectory ?? this.resolveExportDirectory()
          if (!exportDirectory) {
            throw new Error(
              'The selected save folder is unavailable. The completed recording remains safely stored on this computer.',
            )
          }
          const localFile = await exportFinalizedRecording(manifest.file, exportDirectory)
          manifest.state = 'done'
          manifest.localExportPath = localFile
          manifest.error = undefined
          await this.writeManifest()

          const completion: FlowcastCompletion = {
            storageMode: 'local',
            location: localFile,
          }
          this.lastCompletion = completion
          this.events.onDone?.(completion)
          this.manifest = null
          this.activeExportDirectory = null
          this.setState('idle')
          return completion
        }

        this.setState('uploading')
        const result = await uploadRecording(manifest, {
          onProgress: (progress) => this.setState('uploading', { percent: progress.percent }),
          onManifestChange: () => void this.writeManifest(),
        })

        // Copied only now, once the video is actually watchable. Copying it the
        // instant recording stops feels faster but produces a link that shows
        // "uploading" to whoever it is sent to — and WhatsApp caches that
        // preview essentially forever. Private recordings deliberately have no
        // viewer link; their owner opens them from the authenticated library.
        if (manifest.visibility === 'unlisted') clipboard.writeText(result.shareUrl)
        const completion: FlowcastCompletion = {
          storageMode: 'cloud',
          location: result.shareUrl,
        }
        this.lastCompletion = completion
        this.events.onDone?.(completion)

        this.manifest = null
        this.activeExportDirectory = null
        this.setState('idle')
        return completion
      } catch (error) {
        log.error('[flowcast] stop failed', error)
        if (manifest) {
          manifest.state = 'failed'
          manifest.error = error instanceof Error ? error.message : String(error)
          await this.writeManifest()
        }
        this.activeExportDirectory = null
        this.setState('idle')
        this.events.onError?.(
          error instanceof Error ? error.message : 'The recording could not be saved.',
        )
        return null
      }
    })
  }

  /**
   * Look for recordings left behind by a crash, and finish uploading them.
   *
   * This is what makes a crash survivable. When Electron dies, the recorder
   * sees its input stream close, writes the index into the MP4 and exits — so
   * a complete, playable file is sitting on disk with a manifest saying it
   * never finished uploading. Run this at startup.
   */
  recoverAbandonedSessions(): Promise<number> {
    if (this.recoveryPromise) return this.recoveryPromise
    this.recoveryPromise = this.doRecoverAbandonedSessions().finally(() => {
      this.recoveryPromise = null
    })
    return this.recoveryPromise
  }

  private async doRecoverAbandonedSessions(): Promise<number> {
    const root = path.join(app.getPath('userData'), 'flowcast')
    const activeOwner = getAuthContext()?.ownerId
    let recovered = 0

    let entries: string[]
    try {
      entries = await fs.promises.readdir(root)
    } catch {
      return 0
    }

    for (const entry of entries) {
      const sessionDir = path.join(root, entry)
      const manifestPath = path.join(sessionDir, 'manifest.json')
      try {
        const manifest: SessionManifest = JSON.parse(
          await fs.promises.readFile(manifestPath, 'utf8'),
        )
        if (manifest.state === 'done') continue
        const destination: FlowcastStorageMode =
          manifest.destination === 'cloud' ? 'cloud' : 'local'
        if (destination === 'cloud' && (!activeOwner || manifest.ownerId !== activeOwner)) {
          log.warn(`[flowcast] leaving session ${entry} for its original account`)
          continue
        }
        // Never trust a persisted path when deciding what local file to upload.
        // The recorder has exactly one fixed output inside its session folder.
        manifest.file = path.join(sessionDir, 'recording.mp4')
        manifest.visibility = manifest.visibility === 'unlisted' ? 'unlisted' : 'private'
        try {
          const metadata = JSON.parse(
            await fs.promises.readFile(path.join(sessionDir, 'recording.meta.json'), 'utf8'),
          ) as Record<string, unknown>
          if (typeof metadata.durationMs === 'number' && metadata.durationMs > 0) {
            manifest.durationMs = metadata.durationMs
          }
          if (typeof metadata.width === 'number' && metadata.width > 0) {
            manifest.width = metadata.width
          }
          if (typeof metadata.height === 'number' && metadata.height > 0) {
            manifest.height = metadata.height
          }
        } catch {
          // Older interrupted sessions have no native recovery metadata.
        }
        if (!fs.existsSync(manifest.file)) continue

        const stat = await fs.promises.stat(manifest.file)
        if (stat.size === 0) continue
        manifest.bytes = stat.size
        manifest.state = 'stopped'
        manifest.destination = destination
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

        if (destination === 'local') {
          const exportDirectory = this.resolveExportDirectory(manifest.localExportDirectory)
          if (!exportDirectory) {
            log.warn(`[flowcast] save folder unavailable; leaving local session ${entry} for recovery`)
            continue
          }
          const localFile = await exportFinalizedRecording(manifest.file, exportDirectory)
          manifest.state = 'done'
          manifest.localExportPath = localFile
          manifest.error = undefined
          await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
          this.lastCompletion = { storageMode: 'local', location: localFile }
          log.info(`[flowcast] recovered local recording ${localFile}`)
          recovered++
          continue
        }

        log.info(`[flowcast] finishing an interrupted recording: ${manifest.sessionId}`)
        const result = await uploadRecording(manifest, {
          onManifestChange: (updated) =>
            void fs.promises.writeFile(manifestPath, JSON.stringify(updated, null, 2)),
        })
        log.info(`[flowcast] recovered ${result.shareUrl}`)
        recovered++
      } catch (error) {
        log.warn(`[flowcast] could not recover ${entry}`, error)
      }
    }

    return recovered
  }

  /** Delete finished sessions older than a week, so recordings do not quietly
   *  fill the system drive. An hour of recording is about 500 MB. */
  async sweepOldSessions(keepDays = 7): Promise<void> {
    const root = path.join(app.getPath('userData'), 'flowcast')
    const cutoff = Date.now() - keepDays * 86_400_000

    try {
      for (const entry of await fs.promises.readdir(root)) {
        const dir = path.join(root, entry)
        try {
          const manifest: SessionManifest = JSON.parse(
            await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8'),
          )
          if (manifest.state === 'done' && manifest.createdAtUnixMs < cutoff) {
            await fs.promises.rm(dir, { recursive: true, force: true })
          }
        } catch {
          // No manifest, or unreadable. Leave it alone rather than guessing.
        }
      }
    } catch {
      // No folder yet — nothing to sweep.
    }
  }

  async shutdown(): Promise<void> {
    if (this.maximumTimer) {
      clearTimeout(this.maximumTimer)
      this.maximumTimer = null
    }
    await this.sidecar.shutdown()
    this.setState('idle')
  }

  // ── internals ────────────────────────────────────────────────────────────

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  private setState(state: FlowcastState, detail?: { elapsedMs?: number; percent?: number }): void {
    this.state = state
    if (state === 'idle') releaseMedia('flowcast')
    this.events.onState?.(state, { elapsedMs: this.elapsedMs(), ...detail })
    if (state === 'idle') this.activeOptions = null
  }

  private async writeManifest(): Promise<void> {
    if (!this.manifest) return
    const target = path.join(path.dirname(this.manifest.file), 'manifest.json')
    try {
      // Write then rename, so a crash mid-write never leaves a half-written
      // manifest that cannot be parsed on the next launch.
      const temporary = `${target}.tmp`
      await fs.promises.writeFile(temporary, JSON.stringify(this.manifest, null, 2))
      await fs.promises.rename(temporary, target)
    } catch (error) {
      log.warn('[flowcast] could not write the session manifest', error)
    }
  }

  private async cleanupSession(): Promise<void> {
    if (!this.manifest) return
    try {
      await fs.promises.rm(path.dirname(this.manifest.file), { recursive: true, force: true })
    } catch {
      // Nothing to do — the weekly sweep will get it.
    }
    this.manifest = null
    this.activeExportDirectory = null
  }
}

/** Free space on the drive holding `dir`, in megabytes. Null if it cannot be
 *  determined, which the caller treats as "carry on". */
async function freeSpaceMb(dir: string): Promise<number | null> {
  try {
    const stats = await fs.promises.statfs(dir)
    return (stats.bavail * stats.bsize) / 1024 / 1024
  } catch {
    return null
  }
}
