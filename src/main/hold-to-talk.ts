import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

export function acceleratorKeys(acc: string): number[] | null {
  const names: Record<string, number> = { control: 17, ctrl: 17, shift: 16, alt: 18, option: 18, space: 32, tab: 9, backspace: 8, delete: 46, return: 13, enter: 13, escape: 27, up: 38, down: 40, left: 37, right: 39, home: 36, end: 35, pageup: 33, pagedown: 34 }
  const keys = acc.toLowerCase().split('+').map(k => names[k] ?? (/^f([1-9]|1\d|2[0-4])$/.test(k) ? 111 + Number(k.slice(1)) : /^[a-z0-9]$/.test(k) ? k.toUpperCase().charCodeAt(0) : 0))
  return keys.every(Boolean) ? keys : null
}
function monitorPath(): string { return app.isPackaged ? path.join(process.resourcesPath, 'flowcast', 'hold-key-monitor.exe') : path.join(app.getAppPath(), 'native', 'bin', 'hold-key-monitor.exe') }
export function holdAvailable(acc: string): boolean { return process.platform === 'win32' && !!acceleratorKeys(acc) && fs.existsSync(monitorPath()) }
let current: ChildProcess | null = null
export function cancelHold(): void { const child = current; current = null; child?.kill() }
/** The global shortcut reserves the chord. This helper observes only its release. */
export function watchKeyRelease(acc: string, release: () => void): void {
  cancelHold()
  const keys = acceleratorKeys(acc)
  if (!keys || !holdAvailable(acc)) throw new Error('Hold-to-talk is unavailable for this shortcut')
  const child = spawn(monitorPath(), keys.map(String), { windowsHide: true, stdio: 'ignore' })
  current = child
  const done = () => { if (current !== child) return; current = null; release() }
  child.once('exit', done)
  child.once('error', done)
}
