// Sends the finished MP4 to storage.
//
// WHY ELECTRON UPLOADS AND NOT THE RECORDER:
//   * The Supabase login token lives here (src/main/ipc.ts) and rotates every
//     hour. Passing a rotating token across a process boundary and rewriting
//     the refresh logic in Rust would be pure downside.
//   * The recorder having NO network access at all is worth a great deal. It
//     means no Windows Firewall prompt on first run, and "this program cannot
//     talk to the internet" is a much better answer when an unsigned program
//     that reads your screen gets flagged by antivirus software.
//
// The file on disk is the source of truth. Uploading is downstream of it and
// can be retried, resumed, or picked up on the next launch — none of which
// puts the recording itself at risk.

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import log from 'electron-log/main'

import { createRecording, finaliseRecording, FlowcastApiError, requestMoreParts } from './api'
import type { SessionManifest } from './types'
import { getAuthContext } from '../ipc'

/** Two at a time. Enough to fill a normal connection without making a Teams
 *  call unusable while a recording uploads in the background. */
const CONCURRENCY = 2
const PART_RETRIES = 4
/** Storage requires every part except the last to be at least 5 MiB. This is a
 *  hard rule in the storage API, not a preference — 8 MiB gives headroom. */
const PART_BYTES = 8 * 1024 * 1024

export interface UploadResult {
  recordingId: string
  shareId: string
  shareUrl: string
}

export interface UploadProgress {
  uploadedBytes: number
  totalBytes: number
  percent: number
}

/**
 * Upload a finished recording.
 *
 * `manifest` is updated as it goes and should be written to disk by the
 * caller after each callback, so an upload interrupted by a crash or a closed
 * laptop resumes from where it stopped rather than starting again.
 */
export async function uploadRecording(
  manifest: SessionManifest,
  options: {
    title?: string
    onProgress?: (progress: UploadProgress) => void
    onManifestChange?: (manifest: SessionManifest) => void
    signal?: AbortSignal
  } = {},
  closedReservationRetries = 0,
): Promise<UploadResult> {
  const activeOwner = getAuthContext()?.ownerId
  if (!activeOwner || activeOwner !== manifest.ownerId) {
    throw new Error('Sign in with the account that created this recording to finish uploading it.')
  }
  const stat = await fs.promises.stat(manifest.file)
  const totalBytes = stat.size
  if (totalBytes === 0) throw new Error('the recording file is empty')
  manifest.bytes = totalBytes

  const partCount = Math.max(1, Math.ceil(totalBytes / PART_BYTES))

  // Resume, or start fresh.
  let recordingId = manifest.recordingId
  let shareId = manifest.shareId
  let shareUrl = manifest.shareUrl
  let partUrls = new Map<number, string>()

  if (!recordingId) {
    manifest.createRequestId ??= randomUUID()
    options.onManifestChange?.(manifest)
    let created: Awaited<ReturnType<typeof createRecording>>
    try {
      created = await createRecording({
        title: options.title,
        requestId: manifest.createRequestId,
        partCount,
        totalBytes,
        durationSeconds: Math.max(1, Math.ceil(manifest.durationMs / 1000)),
        width: manifest.width,
        height: manifest.height,
        visibility: manifest.visibility,
      })
    } catch (error) {
      if (isClosedUpload(error) && closedReservationRetries < 1) {
        resetClosedReservation(manifest)
        options.onManifestChange?.(manifest)
        return uploadRecording(manifest, options, closedReservationRetries + 1)
      }
      throw error
    }
    recordingId = created.id
    shareId = created.shareId
    shareUrl = created.shareUrl
    partUrls = new Map(created.parts.map((p) => [p.partNumber, p.url]))

    manifest.recordingId = recordingId
    manifest.shareId = shareId
    manifest.shareUrl = shareUrl
    manifest.uploadId = created.uploadId
    manifest.state = 'uploading'
    options.onManifestChange?.(manifest)
  }

  const done = new Map<number, string>(
    (manifest.uploadedParts ?? []).map((p) => [p.partNumber, p.etag]),
  )
  const outstanding = Array.from({ length: partCount }, (_, i) => i + 1).filter(
    (n) => !done.has(n),
  )

  // Upload addresses expire after six hours, so a resumed upload needs new
  // ones. Cheaper to always ask than to work out whether they are still valid.
  if (outstanding.length > 0 && partUrls.size === 0) {
    let fresh: Awaited<ReturnType<typeof requestMoreParts>>
    try {
      fresh = await requestMoreParts(recordingId, outstanding.slice(0, 100))
    } catch (error) {
      if (isClosedUpload(error) && closedReservationRetries < 1) {
        resetClosedReservation(manifest)
        options.onManifestChange?.(manifest)
        return uploadRecording(manifest, options, closedReservationRetries + 1)
      }
      throw error
    }
    partUrls = new Map(fresh.parts.map((p) => [p.partNumber, p.url]))
  }

  let uploadedBytes = done.size * PART_BYTES
  const report = () =>
    options.onProgress?.({
      uploadedBytes: Math.min(uploadedBytes, totalBytes),
      totalBytes,
      percent: Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)),
    })
  report()

  const handle = await fs.promises.open(manifest.file, 'r')
  try {
    const queue = [...outstanding]

    const worker = async () => {
      for (;;) {
        const partNumber = queue.shift()
        if (partNumber === undefined) return
        if (options.signal?.aborted) throw new Error('upload cancelled')

        let url = partUrls.get(partNumber)
        if (!url) {
          const fresh = await requestMoreParts(recordingId!, [partNumber])
          url = fresh.parts[0]?.url
          if (!url) throw new Error(`no upload address for part ${partNumber}`)
        }

        const offset = (partNumber - 1) * PART_BYTES
        const length = Math.min(PART_BYTES, totalBytes - offset)
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, offset)

        const etag = await putPart(url, buffer, partNumber, recordingId!, options.signal)
        done.set(partNumber, etag)
        uploadedBytes += length
        report()

        manifest.uploadedParts = [...done].map(([n, e]) => ({ partNumber: n, etag: e }))
        options.onManifestChange?.(manifest)
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker))
  } finally {
    await handle.close()
  }

  let finalised: Awaited<ReturnType<typeof finaliseRecording>>
  try {
    finalised = await finaliseRecording(recordingId, {
      etags: [...done].map(([partNumber, etag]) => ({ partNumber, etag })),
      durationSeconds: Math.max(1, Math.ceil(manifest.durationMs / 1000)),
      sizeBytes: totalBytes,
      width: manifest.width,
      height: manifest.height,
      hasPoster: false,
      hasAudio: false,
    })
  } catch (error) {
    if (isClosedUpload(error) && closedReservationRetries < 1) {
      resetClosedReservation(manifest)
      options.onManifestChange?.(manifest)
      return uploadRecording(manifest, options, closedReservationRetries + 1)
    }
    throw error
  }

  manifest.state = 'done'
  manifest.shareUrl = finalised.shareUrl
  options.onManifestChange?.(manifest)

  return {
    recordingId: finalised.id,
    shareId: finalised.shareId,
    shareUrl: finalised.shareUrl,
  }
}

function isClosedUpload(error: unknown): boolean {
  return error instanceof FlowcastApiError && error.reason === 'upload_closed'
}

function resetClosedReservation(manifest: SessionManifest): void {
  delete manifest.recordingId
  delete manifest.shareId
  delete manifest.shareUrl
  delete manifest.uploadId
  manifest.createRequestId = randomUUID()
  manifest.uploadedParts = []
  manifest.state = 'stopped'
  delete manifest.error
}

/** One part, with retries.
 *
 *  A 403 means the upload address has expired rather than that anything is
 *  wrong, so that case asks for a new one instead of counting against the
 *  retry budget. */
async function putPart(
  url: string,
  body: Buffer,
  partNumber: number,
  recordingId: string,
  signal?: AbortSignal,
): Promise<string> {
  let lastError: unknown

  for (let attempt = 0; attempt < PART_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('upload cancelled')

    try {
      const response = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'content-type': 'video/mp4', 'content-length': String(body.length) },
        signal,
      })

      if (response.status === 403) {
        const fresh = await requestMoreParts(recordingId, [partNumber])
        const next = fresh.parts[0]?.url
        if (!next) throw new Error('could not refresh the upload address')
        url = next
        continue
      }

      if (!response.ok) throw new Error(`storage rejected part ${partNumber} (${response.status})`)

      // Storage needs these back, exactly as given, to assemble the file.
      const etag = response.headers.get('etag')
      if (!etag) throw new Error(`storage did not confirm part ${partNumber}`)
      return etag
    } catch (error) {
      lastError = error
      const backoffMs = 1000 * 2 ** attempt
      log.warn(`[flowcast] part ${partNumber} failed, retrying in ${backoffMs}ms`, error)
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`part ${partNumber} failed`)
}
