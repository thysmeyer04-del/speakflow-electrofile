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
  environment: Environment = process.env,
  exists: Exists = fs.existsSync,
): string | null {
  const configured = configuredDirectory?.trim()
  if (configured && path.isAbsolute(configured)) return path.normalize(configured)

  const root = detectOneDriveRoot(environment, exists)
  return root ? path.join(root, DEFAULT_EXPORT_FOLDER_NAME) : null
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

/** Copy an already-finalized MP4 to staging outside OneDrive, flush it, then
 *  atomically rename it into the sync directory. The EXDEV fallback uses a
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
      throw new Error('The OneDrive copy did not match the completed recording.')
    }
    return finalFile
  } finally {
    await fs.promises.rm(stagingFile, { force: true }).catch(() => undefined)
    await fs.promises.rm(partialFile, { force: true }).catch(() => undefined)
  }
}
