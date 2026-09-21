import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
if (process.platform === 'win32') {
  mkdirSync('native/bin', { recursive: true })
  const result = spawnSync('rustc', ['--edition=2021', '-O', 'native/hold-key-monitor.rs', '-o', 'native/bin/hold-key-monitor.exe'], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
