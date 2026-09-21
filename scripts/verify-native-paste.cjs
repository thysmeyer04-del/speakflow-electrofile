// Run using Electron, after build:ts. Uses real native Ctrl+V in an isolated
// fixture window; does not open user documents, accounts, or send messages.
const { app, BrowserWindow, clipboard, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'speakflow-paste-test-'))
app.setPath('userData', profile)
app.disableHardwareAcceleration()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let window
const results = []
app.whenReady().then(async () => {
  const { injectText, captureFocusTarget } = require('../dist/main/inject')
  const { withClipboard, snapshotClipboard } = require('../dist/main/clipboard-transaction')
  const restoreUserClipboard = snapshotClipboard()
  const preload = path.join(profile, 'preload.cjs')
  fs.writeFileSync(preload, "require('electron').contextBridge.exposeInMainWorld('fixture', {readClipboard: () => require('electron').ipcRenderer.invoke('fixture:clipboard')})")
  window = new BrowserWindow({ width: 700, height: 600, title: 'Speakflow paste verification', webPreferences: { preload, contextIsolation: true, sandbox: true } })
  ipcMain.handle('fixture:clipboard', (event) => {
    if (event.sender !== window.webContents) throw new Error('unexpected sender')
    return clipboard.readText()
  })
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
      <title>Speakflow paste verification</title><style>body{font:16px sans-serif;padding:20px}input,textarea,[contenteditable]{display:block;border:1px solid #888;margin:12px;padding:8px;width:90%}</style>
      <h2>Speakflow native paste test</h2><p>Testing isolated fields. This window closes automatically.</p>
      <input id="plain"><input id="email" type="email"><input id="search" type="search"><textarea id="textarea"></textarea>
      <div id="rich" contenteditable="true"></div><div id="shadow"></div><iframe id="frame" srcdoc="<textarea id='inner'></textarea>"></iframe>
      <textarea id="slow"></textarea>
      <script>
        document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<textarea id="inner"></textarea>';
        document.querySelector('#slow').addEventListener('paste', e => {e.preventDefault(); setTimeout(async () => {e.target.value=await window.fixture.readClipboard()},350)});
      </script>`))
    window.show()
    window.focus()
    console.log('Waiting for you to click the Speakflow paste verification window...')
    const focusDeadline = Date.now() + 180_000
    while ((await captureFocusTarget())?.title !== 'Speakflow paste verification') {
      if (Date.now() > focusDeadline) throw new Error('Click the verification window, then rerun this test.')
      await sleep(250)
    }
    const cases = [
      ['plain', "Please do not change invoice 48219."],
      ['email', 'thys@example.com'],
      ['search', 'English dictation test'],
      ['textarea', 'Hello Thys,\n\nPlease send the quote tomorrow.\nThank you.'],
      ['rich', 'Email body with Unicode: café — £45 ✅'],
      ['shadow', 'Shadow editor text'],
      ['frame', 'Embedded email composer'],
      ['slow', 'The dictated text, never the old clipboard.'],
      ['textarea', 'Long dictation. '.repeat(600)],
    ]
    for (const [id, text] of cases) {
      const expression = id === 'shadow' ? "document.querySelector('#shadow').shadowRoot.querySelector('textarea')"
        : id === 'frame' ? "document.querySelector('#frame').contentDocument.querySelector('textarea')"
        : `document.getElementById(${JSON.stringify(id)})`
      await window.webContents.executeJavaScript(`(()=>{const el=${expression}; if(el.isContentEditable) el.textContent=''; else el.value=''; el.focus();})()`)
      clipboard.writeText('OLD CLIPBOARD - must never be inserted')
      const start = Date.now()
      const target = await captureFocusTarget()
      assert.ok(target?.title === 'Speakflow paste verification', 'Test window must have foreground focus')
      assert.equal(window.isFocused(), true, 'Test window must have focus')
      console.log('fixture focus', await window.webContents.executeJavaScript('({focused:document.hasFocus(),active:document.activeElement.id})'))
      const result = await injectText(text, target, { requireSameTarget: true })
      const dispatchMs = Date.now() - start
      assert.equal(result.ok, true, `${id}: ${result.error}`)
      await withClipboard(async () => {})
      const actual = await window.webContents.executeJavaScript(`(()=>{const el=${expression};return el.isContentEditable?el.innerText:el.value})()`)
      assert.equal(actual.replace(/\r\n/g, '\n'), text, `${id}: inserted content differs`)
      results.push({ field: id, chars: text.length, dispatchMs, passed: true })
    }
    fs.writeFileSync(path.resolve('audit-native-paste.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify({ passed: results.length, results }))
  } finally {
    await withClipboard(async () => {})
    restoreUserClipboard()
    window.destroy()
  }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
