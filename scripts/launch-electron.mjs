import { spawn } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

delete process.env.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env },
})

child.on('exit', (code) => process.exit(code ?? 0))
