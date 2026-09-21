const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const asar = require('@electron/asar')
const output = path.resolve('dist-electron-audit')
const archive = path.join(output, 'win-unpacked/resources/app.asar')
const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
assert.equal(metadata.version, '0.10.1-audit.1')
let checked = 0
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (!file.endsWith('.map') && !file.endsWith('.ts')) {
      const relative = path.relative(process.cwd(), file).split(path.sep).join('/')
      assert.ok(fs.readFileSync(file).equals(asar.extractFile(archive, relative)), `stale packaged file: ${relative}`)
      checked++
    }
  }
}
walk(path.resolve('dist'))
const installer = path.join(output, 'Speakflow-Setup.exe')
const manifest = {
  version: metadata.version, checkedFiles: checked,
  installerBytes: fs.statSync(installer).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex'),
  nativeAcceptance: 'pending; no claim of universal insertion or accuracy parity',
}
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify(manifest))
