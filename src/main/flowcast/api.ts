// Talking to the Speakflow server about recordings.
//
// Reuses what src/main/transcribe.ts already has: getProxyBaseUrl() for the
// address, isProxyUrlAllowed() to check it, and fetchWithTimeout(). Those are
// not re-implemented here — when this is copied into the desktop app, import
// them rather than copying them.

import log from 'electron-log/main'
import { getAuthToken } from '../ipc'
import { getProxyBaseUrl } from '../transcribe'
import { isProxyUrlAllowed } from '../security'

export interface RecordingPreflight {
  enabled: boolean
  maxDurationSeconds: number
  maxStoredBytes: number
  reason?: string
}

export interface CreatedRecording {
  id: string
  shareId: string
  shareUrl: string
  uploadId: string
  parts: { partNumber: number; url: string }[]
  partSizeBytes: number
  posterUploadUrl: string | null
  audioUploadUrl: string | null
  urlsExpireAt: string
  limits: { maxDurationSeconds: number; maxStoredBytes: number }
}

export interface FinalisedRecording {
  id: string
  shareId: string
  shareUrl: string
  status: string
  playbackUrl: string | null
}

/** Anything the person can be shown directly. `reason` distinguishes a limit
 *  from a genuine failure so the app can offer "upgrade" rather than "retry". */
export class FlowcastApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'FlowcastApiError'
  }
}

const TIMEOUT_MS = 20_000

async function call<T>(
  pathname: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const base = getProxyBaseUrl()
  if (!base) throw new FlowcastApiError('Not connected to Speakflow.', 0)
  if (!isProxyUrlAllowed(base)) {
    throw new FlowcastApiError('The Speakflow API address is not trusted.', 0)
  }

  const token = getAuthToken()
  if (!token) throw new FlowcastApiError('Please sign in to save recordings.', 401)

  const url = `${base.replace(/\/+$/, '')}/flowcast${pathname}`
  const response = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let payload: Record<string, unknown> = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    // Not JSON — probably an infrastructure error page.
  }

  if (!response.ok) {
    const message =
      typeof payload.error === 'string' ? payload.error : `Request failed (${response.status}).`
    throw new FlowcastApiError(
      message,
      response.status,
      typeof payload.reason === 'string' ? payload.reason : undefined,
    )
  }

  return payload as T
}

/** Lightweight auth/storage/quota check before screen capture begins. */
export function preflightRecording(): Promise<RecordingPreflight> {
  return call<RecordingPreflight>('/recordings/preflight', { method: 'GET' })
}

export function createRecording(input: {
  title?: string
  requestId: string
  partCount: number
  totalBytes: number
  durationSeconds: number
  width: number
  height: number
  visibility: 'private' | 'unlisted'
  posterBytes?: number
  audioBytes?: number
}): Promise<CreatedRecording> {
  return call<CreatedRecording>('/recordings', { method: 'POST', body: input })
}

export function requestMoreParts(
  recordingId: string,
  partNumbers: number[],
): Promise<{ parts: { partNumber: number; url: string }[]; urlsExpireAt: string }> {
  return call(`/recordings/${recordingId}/parts`, {
    method: 'POST',
    body: { partNumbers },
  })
}

export function finaliseRecording(
  recordingId: string,
  input: {
    etags: { partNumber: number; etag: string }[]
    durationSeconds: number
    sizeBytes: number
    width?: number
    height?: number
    hasPoster?: boolean
    hasAudio?: boolean
  },
): Promise<FinalisedRecording> {
  return call(`/recordings/${recordingId}/finalise`, { method: 'POST', body: input })
}

export async function deleteRecording(recordingId: string): Promise<void> {
  try {
    await call(`/recordings/${recordingId}`, { method: 'DELETE' })
  } catch (error) {
    log.warn('[flowcast] could not delete the recording', error)
  }
}
