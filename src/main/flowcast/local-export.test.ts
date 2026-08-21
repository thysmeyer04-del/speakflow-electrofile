import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_EXPORT_FOLDER_NAME,
  detectOneDriveRoot,
  exportFinalizedRecording,
  resolveLocalExportDirectory,
  validateLocalExportDirectory,
} from './local-export'

test('OneDrive detection prefers the business sync root and ignores relative paths', () => {
  const existing = new Set([path.normalize('C:\\Business'), path.normalize('C:\\Consumer')])
  const environment = {
    OneDriveCommercial: 'C:\\Business',
    OneDriveConsumer: 'C:\\Consumer',
    OneDrive: 'relative-folder',
  }
  const exists = (candidate: string): boolean => existing.has(path.normalize(candidate))

  assert.equal(detectOneDriveRoot(environment, exists), path.normalize('C:\\Business'))
  assert.equal(resolveLocalExportDirectory(undefined, environment, exists), null)
})

test('an explicitly selected absolute folder overrides OneDrive auto-detection', () => {
  const selected = path.resolve('chosen-flowcast-folder')
  assert.equal(resolveLocalExportDirectory(selected, {}, () => false), selected)
})

test('the selected local folder is created and verified as writable', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'speakflow-flowcast-folder-'))
  try {
    const selected = path.join(root, 'new destination')
    assert.equal(await validateLocalExportDirectory(selected), path.normalize(selected))
    assert.equal((await fs.promises.readdir(selected)).length, 0)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('a finalized MP4 is exported under its final name with no partial files left behind', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'speakflow-flowcast-export-'))
  try {
    const session = path.join(root, 'session')
    const destination = path.join(root, 'OneDrive', DEFAULT_EXPORT_FOLDER_NAME)
    await fs.promises.mkdir(session, { recursive: true })
    const source = path.join(session, 'recording.mp4')
    const content = Buffer.from('finalized-mp4-test-payload')
    await fs.promises.writeFile(source, content)

    const exported = await exportFinalizedRecording(source, destination, {
      now: new Date(2026, 7, 20, 9, 30, 45),
      uniqueId: 'abc12345',
    })

    assert.equal(path.basename(exported), 'Speakflow-20260820-093045-abc12345.mp4')
    assert.deepEqual(await fs.promises.readFile(exported), content)
    assert.deepEqual(await fs.promises.readFile(source), content)
    assert.deepEqual(
      (await fs.promises.readdir(destination)).filter((name) => name.includes('partial')),
      [],
    )
    assert.deepEqual(
      (await fs.promises.readdir(session)).filter((name) => name.includes('flowcast-export')),
      [],
    )
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('local mode bypasses cloud admission and exports only after the recorder stops', () => {
  const controller = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'flowcast', 'controller.ts'),
    'utf8',
  )
  const cloudGate = controller.indexOf("if (storageMode === 'cloud')")
  const preflight = controller.indexOf('await preflightRecording()', cloudGate)
  const recorderStop = controller.indexOf('await this.sidecar.stopRecording(discard)')
  const localExport = controller.indexOf('await exportFinalizedRecording(', recorderStop)

  assert.ok(cloudGate >= 0)
  assert.ok(preflight > cloudGate)
  assert.ok(recorderStop >= 0)
  assert.ok(localExport > recorderStop)
  assert.match(controller, /destination: storageMode/)
})
