const { build, Platform } = require('electron-builder')
build({
  targets: Platform.WINDOWS.createTarget(),
  publish: 'never',
  config: {
    extends: './electron-builder.yml',
    extraMetadata: { version: '0.10.1-audit.1' },
    directories: { output: 'dist-electron-audit' },
  },
}).catch(error => { console.error(error); process.exitCode = 1 })
