// Launches and supervises flowcast-recorder.exe.
//
// Modelled on src/main/recorder.ts, which does the same job for the hidden
// microphone-recorder window: a map of in-flight requests keyed by id, each
// with its own timeout, and every failure logged rather than thrown.
//
// Two rules that keep this safe:
//   * stdout is protocol only. stderr is the recorder's own logging and gets
//     forwarded into main.log. A stray line on stdout would desynchronise the
//     parser, which is why the Rust side has a panic hook writing to stderr.
//   * The recorder is never handed a user-supplied string as a command-line
//     argument. Everything goes through the JSON `start` command, which both
//     sides validate.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'

import type { Caps, Command, Event, StartCommand } from './types'
import { FLOWCAST_PROTOCOL_VERSION } from './types'

const START_TIMEOUT_MS = 8_000
/** Generous on purpose. Stopping is when the video file gets its index written
 *  — cut it short and the recording is lost. */
const STOP_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 10_000

export interface SidecarHandlers {
  onStarted?: (event: Extract<Event, { ev: 'started' }>) => void
  onWarn?: (code: string, message: string) => void
  onStopped?: (event: Extract<Event, { ev: 'stopped' }>) => void
  onError?: (code: string, message: string, fatal: boolean) => void
  onExit?: (code: number | null) => void
}

interface Pending {
  resolve: (event: Event) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class Sidecar {
  private child: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private stopping = false

  constructor(private handlers: SidecarHandlers = {}) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  /** Where the executable lives, packaged and in development.
   *
   *  Resolved and then checked to be inside the folder we expect, so a symlink
   *  cannot redirect us to some other program. */
  static executablePath(): string {
    const root = app.isPackaged
      ? path.join(process.resourcesPath, 'flowcast')
      : path.join(app.getAppPath(), 'native', 'bin')

    const exe = path.join(root, 'flowcast-recorder.exe')
    const resolved = fs.realpathSync(exe)
    if (!resolved.startsWith(fs.realpathSync(root) + path.sep)) {
      throw new Error('the recorder is not where it should be')
    }
    return resolved
  }

  start(): void {
    if (this.child) return

    const exe = Sidecar.executablePath()
    log.info(`[flowcast] launching ${exe}`)

    this.child = spawn(exe, [], {
      windowsHide: true,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.reader = createInterface({ input: this.child.stdout })
    this.reader.on('line', (line) => this.onLine(line))

    createInterface({ input: this.child.stderr }).on('line', (line) => {
      log.info(`[flowcast-recorder] ${line}`)
    })

    this.child.on('exit', (code) => {
      log.info(`[flowcast] recorder exited (${code})`)
      this.failAllPending(new Error('the recorder stopped'))
      this.child = null
      this.reader?.close()
      this.reader = null
      this.handlers.onExit?.(code)
    })

    this.child.on('error', (error) => {
      log.error('[flowcast] could not launch the recorder', error)
      this.failAllPending(error)
    })
  }

  /** Ask what this machine can do. Also the cheapest way to confirm the
   *  recorder launches at all. */
  async probe(): Promise<Caps> {
    this.start()
    const event = await this.request({ cmd: 'probe' }, PROBE_TIMEOUT_MS)
    if (event.ev !== 'ready') throw new Error('the recorder did not answer with its capabilities')
    if (event.caps.protocol_version !== FLOWCAST_PROTOCOL_VERSION) {
      throw new Error(
        `recorder speaks version ${event.caps.protocol_version}, this app speaks ${FLOWCAST_PROTOCOL_VERSION}`,
      )
    }
    return event.caps
  }

  async startRecording(
    command: Omit<StartCommand, 'cmd' | 'parent_pid'>,
  ): Promise<Extract<Event, { ev: 'started' }>> {
    this.start()
    this.stopping = false
    const event = await this.request(
      { ...command, cmd: 'start', parent_pid: process.pid } as StartCommand,
      START_TIMEOUT_MS,
    )
    if (event.ev !== 'started') throw new Error('the recorder did not confirm capture startup')
    return event
  }

  /** Resolves once the file has been finalised and is playable. */
  stopRecording(discard = false): Promise<Extract<Event, { ev: 'stopped' }>> {
    this.stopping = true
    return new Promise((resolve, reject) => {
      if (!this.running) {
        reject(new Error('the recorder is not running'))
        return
      }

      const previous = this.handlers.onStopped

      const timer = setTimeout(() => {
        this.handlers.onStopped = previous
        reject(new Error('the recorder did not finish in time'))
      }, STOP_TIMEOUT_MS)

      this.handlers.onStopped = (event) => {
        clearTimeout(timer)
        this.handlers.onStopped = previous
        previous?.(event)
        resolve(event)
      }

      this.send({ cmd: discard ? 'abort' : 'stop' })
    })
  }

  /** Shut down cleanly.
   *
   *  NEVER kill the process first. On Windows that maps to TerminateProcess,
   *  which cuts the video file off before its index is written and loses the
   *  whole recording. Closing the input stream is the polite signal: the
   *  recorder finalises and exits on its own. */
  async shutdown(): Promise<void> {
    if (!this.child) return

    try {
      if (this.running && !this.stopping) {
        await this.stopRecording().catch(() => undefined)
      }
    } finally {
      this.child?.stdin.end()

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.child) {
            log.warn('[flowcast] recorder did not exit; forcing it')
            this.child.kill()
          }
          resolve()
        }, 5_000)
        this.child?.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private send(command: Command, id?: number): void {
    if (!this.child) throw new Error('the recorder is not running')
    const line = JSON.stringify({ v: FLOWCAST_PROTOCOL_VERSION, id: id ?? 0, ...command })
    this.child.stdin.write(line + '\n')
  }

  private request(command: Command, timeoutMs: number): Promise<Event> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the recorder did not answer "${command.cmd}" in time`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send(command, id)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  private onLine(line: string): void {
    let event: Event
    try {
      event = JSON.parse(line)
    } catch {
      log.warn(`[flowcast] unparseable line on the protocol stream: ${line.slice(0, 200)}`)
      return
    }

    // Answers to a specific request.
    if ('id' in event && typeof event.id === 'number' && this.pending.has(event.id)) {
      const waiter = this.pending.get(event.id)!
      // `ack` only means "heard you" — the real answer comes next.
      if (event.ev !== 'ack') {
        clearTimeout(waiter.timer)
        this.pending.delete(event.id)
        if (event.ev === 'error') waiter.reject(new Error(event.message))
        else waiter.resolve(event)
        return
      }
    }

    switch (event.ev) {
      case 'started':
        this.handlers.onStarted?.(event)
        break
      case 'warn':
        // Audio failures arrive here. The recording is still running.
        log.warn(`[flowcast] ${event.code}: ${event.message}`)
        this.handlers.onWarn?.(event.code, event.message)
        break
      case 'stopped':
        this.handlers.onStopped?.(event)
        break
      case 'error':
        log.error(`[flowcast] ${event.code}: ${event.message}`)
        this.handlers.onError?.(event.code, event.message, event.fatal)
        break
    }
  }

  private failAllPending(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}
