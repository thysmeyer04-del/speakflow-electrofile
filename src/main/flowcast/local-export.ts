import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_EXPORT_FOLDER_NAME = 'Speakflow Flowcast'

type Environment = NodeJS.ProcessEnv
type Exists = (candidate: string) => boolean

/** Find the local OneDrive sync root without calling the OneDrive API. Business
 *  installations expose OneDriveCommercial, consumer installations expose
 *  OneDriveConsumer, and older clients expose OneDrive. */
export function detectOneDriveRoot(
  environment: Environment = process.env,
  exists: Exists = fs.existsSync,
): string | null {
  const candidates = [
    environment.OneDriveCommercial,
    environment.OneDriveConsumer,
    environment.OneDrive,
  ]

  for (const raw of candidates) {
    const candidate = raw?.trim().replace(/^"|"$/g, '')
    if (!candidate || !path.isAbsolute(candidate)) continue
    const normalized = path.normalize(candidate)
    if (exists(normalized)) return normalized
  }
  return null
}

export function resolveLocalExportDirectory(
  configuredDirectory?: string,
  _environment: Environment = process.env,
  _exists: Exists = fs.existsSync,
): string | null {
  const configured = configuredDirectory?.trim()
  if (configured && path.isAbsolute(configured)) return path.normalize(configured)
  return null
}

/** Create the folder if necessary and prove that this process can write,
 * flush, and remove a file there before Flowcast is enabled. */
export async function validateLocalExportDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error('Choose a valid absolute save folder.')
  const normalized = path.normalize(directory)
  await fs.promises.mkdir(normalized, { recursive: true })
  const probe = path.join(normalized, `.speakflow-write-test-${randomUUID()}.tmp`)
  try {
    await fs.promises.writeFile(probe, 'Speakflow Flowcast folder check\n', { flag: 'wx' })
    await flushFile(probe)
  } catch (error) {
    throw new Error(
      `Flowcast cannot write to that folder: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await fs.promises.rm(probe, { force: true }).catch(() => undefined)
  }
  return normalized
}

function timestampForFilename(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('')
}

async function flushFile(file: string): Promise<void> {
  // Windows requires a writable handle for FlushFileBuffers; a read-only
  // descriptor returns EPERM even when the file itself is writable.
  const handle = await fs.promises.open(file, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Copy an already-finalized MP4 to staging, flush it, then atomically rename
 *  it into the destination directory. The EXDEV fallback uses a
 *  .partial name on the destination volume and only exposes the final .mp4
 *  name after the copy and flush complete. */
export async function exportFinalizedRecording(
  sourceFile: string,
  destinationDirectory: string,
  options: { now?: Date; uniqueId?: string } = {},
): Promise<string> {
  if (!path.isAbsolute(sourceFile) || !path.isAbsolute(destinationDirectory)) {
    throw new Error('Flowcast export paths must be absolute.')
  }

  const source = await fs.promises.stat(sourceFile)
  if (!source.isFile() || source.size <= 0) {
    throw new Error('The completed Flowcast recording is empty or missing.')
  }

  await fs.promises.mkdir(destinationDirectory, { recursive: true })
  const uniqueId = (options.uniqueId ?? randomUUID()).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8)
  const baseName = `Speakflow-${timestampForFilename(options.now ?? new Date())}-${uniqueId}.mp4`
  const finalFile = path.join(destinationDirectory, baseName)
  const sourceDirectory = path.dirname(sourceFile)
  const stagingFile = path.join(sourceDirectory, `.flowcast-export-${randomUUID()}.tmp`)
  const partialFile = path.join(destinationDirectory, `.${baseName}.${randomUUID()}.partial`)

  try {
    await fs.promises.copyFile(sourceFile, stagingFile, fs.constants.COPYFILE_EXCL)
    await flushFile(stagingFile)

    try {
      await fs.promises.rename(stagingFile, finalFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await fs.promises.copyFile(stagingFile, partialFile, fs.constants.COPYFILE_EXCL)
      await flushFile(partialFile)
      await fs.promises.rename(partialFile, finalFile)
    }

    const exported = await fs.promises.stat(finalFile)
    if (!exported.isFile() || exported.size !== source.size) {
      throw new Error('The saved copy did not match the completed recording.')
    }
    return finalFile
  } finally {
    await fs.promises.rm(stagingFile, { force: true }).catch(() => undefined)
    await fs.promises.rm(partialFile, { force: true }).catch(() => undefined)
  }
}
