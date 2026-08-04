// Test-only module stubs. Loaded via `node --require` from `npm test`.
//
// The transcription helpers under test (prompt building, the dictate
// dictionary field, the formatter-preservation guard) are pure functions, but
// they live in modules that sit in the Electron main process and therefore
// pull in `electron`, `electron-log`, `electron-store` and the native
// automation deps at import time. Outside an Electron runtime those imports
// blow up before a single assertion runs.
//
// So we intercept them here with inert doubles. Nothing in this file ships:
// it is not imported by any src/ module and never reaches dist/.

const Module = require('module')
const os = require('os')

const noop = () => undefined

// Every property is a no-op function — covers log.info/warn/error/verbose,
// log.transports.*, log.initialize, etc. without enumerating them.
const logStub = new Proxy(function () {}, {
  get(target, prop) {
    if (prop === 'transports' || prop === 'scope' || prop === 'default') return logStub
    if (prop === '__esModule') return false
    return noop
  },
  apply: noop,
})

const electronStub = {
  app: {
    getPath: () => os.tmpdir(),
    getVersion: () => '0.0.0-test',
    getName: () => 'speakflow-test',
    isPackaged: false,
    on: noop,
    once: noop,
    whenReady: () => Promise.resolve(),
    setLoginItemSettings: noop,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    quit: noop,
  },
  ipcMain: { on: noop, once: noop, handle: noop, removeAllListeners: noop, removeHandler: noop },
  ipcRenderer: { on: noop, send: noop, invoke: () => Promise.resolve(null) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() { return [] }
    constructor() { this.webContents = { send: noop, on: noop } }
    on() {} once() {} loadFile() {} destroy() {} isDestroyed() { return false }
  },
  utilityProcess: { fork: () => ({ on: noop, postMessage: noop, kill: noop }) },
  globalShortcut: { register: () => true, unregister: noop, unregisterAll: noop, isRegistered: () => false },
  clipboard: { readText: () => '', writeText: noop, readImage: () => null, writeImage: noop },
  shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve('') },
  Menu: { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop },
  Tray: class Tray { setToolTip() {} setContextMenu() {} on() {} destroy() {} },
  nativeImage: { createFromPath: () => ({ resize: () => ({}), isEmpty: () => true }), createEmpty: () => ({}) },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }), on: noop },
  systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: () => Promise.resolve(true) },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }), showErrorBox: noop },
  powerMonitor: { on: noop },
  session: { defaultSession: { setPermissionRequestHandler: noop } },
}

class ElectronStoreStub {
  constructor(opts) {
    this._defaults = (opts && opts.defaults) || {}
    this._data = { ...this._defaults }
  }
  get(key, fallback) {
    return key in this._data ? this._data[key] : fallback
  }
  set(key, value) {
    if (typeof key === 'object') Object.assign(this._data, key)
    else this._data[key] = value
  }
  delete(key) { delete this._data[key] }
  clear() { this._data = { ...this._defaults } }
  get store() { return this._data }
}

const nutStub = {
  keyboard: { type: () => Promise.resolve(), pressKey: () => Promise.resolve(), releaseKey: () => Promise.resolve(), config: {} },
  mouse: { config: {} },
  clipboard: {},
  Key: new Proxy({}, { get: (_t, p) => String(p) }),
  screen: {},
}

const updaterStub = {
  autoUpdater: { on: noop, checkForUpdates: () => Promise.resolve(null), quitAndInstall: noop, logger: null, autoDownload: false },
}

const supabaseStub = { createClient: () => ({ from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }

const STUBS = new Map([
  ['electron', electronStub],
  ['electron-log', logStub],
  ['electron-log/main', logStub],
  ['electron-log/renderer', logStub],
  ['electron-store', ElectronStoreStub],
  ['electron-updater', updaterStub],
  ['@nut-tree-fork/nut-js', nutStub],
  ['@supabase/supabase-js', supabaseStub],
])

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (STUBS.has(request)) return STUBS.get(request)
  return originalLoad.call(this, request, parent, isMain)
}
