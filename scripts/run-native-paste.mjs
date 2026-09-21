import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [process.argv[2] ?? 'scripts/verify-native-paste.cjs'], { env, stdio: 'inherit' })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
