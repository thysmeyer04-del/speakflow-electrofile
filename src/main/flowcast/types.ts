// The other half of the wire protocol. These MUST stay in step with
// flowcast/recorder/src/protocol.rs — if you change one, change the other.

export const FLOWCAST_PROTOCOL_VERSION = 2

export type CameraSize = 'small' | 'medium' | 'large'
export type InkColor = 'red' | 'yellow' | 'green' | 'blue' | 'white'
export interface OverlayPoint { x: number; y: number }

// ── Commands we send ────────────────────────────────────────────────────────

export interface StartCommand {
  cmd: 'start'
  session: string
  /** Must already exist. The recorder writes `recording.mp4` inside it. */
  out_dir: string
  source: { kind: 'monitor'; index?: number } | { kind: 'window'; index: number }
  video: { width: number; height: number; fps: number; bitrate: number }
  audio: { mic: boolean; system: boolean; bitrate: number }
  click_highlight: boolean
  cursor: boolean
  /** So the recorder exits if Electron disappears without closing its input. */
  parent_pid: number
}

export type Command =
  | { cmd: 'probe' }
  | StartCommand
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'stop' }
  | { cmd: 'abort' }
  | { cmd: 'camera_layout'; visible: boolean; x: number; y: number; size: CameraSize }
  | { cmd: 'camera_frame'; data: string }
  | { cmd: 'draw_stroke'; color: InkColor; width: number; points: OverlayPoint[] }
  | { cmd: 'clear_ink' }

// ── Events we receive ───────────────────────────────────────────────────────

export interface MonitorInfo {
  index: number
  name: string
  device_name: string
  width: number
  height: number
  x: number
  y: number
}

export interface WindowInfo {
  index: number
  title: string
  process_name: string
  width: number
  height: number
  x: number
  y: number
}

export interface DeviceInfo {
  id: string
  name: string
  default: boolean
}

export interface Caps {
  protocol_version: number
  recorder_version: string
  /** Set only after the packaged runtime completes a real H.264 encode. */
  h264_available: boolean
  h264_error?: string
  monitors: MonitorInfo[]
  windows: WindowInfo[]
  microphones: DeviceInfo[]
}

export type Event =
  | { v: number; ev: 'ready'; id: number; caps: Caps }
  | { v: number; ev: 'ack'; id: number; cmd: string }
  | {
      v: number
      ev: 'started'
      /** The id of the `start` command that caused this, so it can be matched
       *  to its request. Absent only in the recorder's standalone test mode. */
      id?: number
      session: string
      started_at_unix_ms: number
      width: number
      height: number
      fps: number
    }
  | { v: number; ev: 'paused'; id: number; session: string; paused: boolean }
  | {
      v: number
      ev: 'stats'
      elapsed_ms: number
      frames: number
      skipped: number
      audio_chunks: number
      disk_free_mb: number
    }
  | { v: number; ev: 'warn'; code: string; message: string }
  | {
      v: number
      ev: 'stopped'
      /** Absent when nobody asked — which is the crash case: Electron died,
       *  the recorder saw its input close and finalised the file on its own. */
      id?: number
      session: string
      file: string
      bytes: number
      duration_ms: number
      frames: number
    }
  | { v: number; ev: 'error'; id?: number; code: string; fatal: boolean; message: string }

// ── Local session record ────────────────────────────────────────────────────

/** Written next to the MP4 as `manifest.json`, and the reason a recording
 *  survives Electron crashing: on the next launch we scan for manifests whose
 *  state is not `done` and offer to finish the job. */
export interface SessionManifest {
  v: 1
  sessionId: string
  /** Supabase subject that created the recording. Recovery must never upload
   *  this file while a different account is active. */
  ownerId: string
  /** Cloud is the dormant multipart path. Local exports only a completed,
   *  validated MP4 to the selected folder. `onedrive` is a legacy value. */
  destination?: 'cloud' | 'local' | 'onedrive'
  state: 'recording' | 'stopped' | 'uploading' | 'done' | 'failed'
  createdAtUnixMs: number
  file: string
  bytes: number
  durationMs: number
  width: number
  height: number
  visibility: 'private' | 'unlisted'
  /** Assigned after capture, before multipart upload begins. */
  recordingId?: string
  createRequestId?: string
  shareId?: string
  shareUrl?: string
  /** Present after a local recording has been copied successfully. */
  localExportPath?: string
  /** The user-selected folder, used only to resume a local export
   *  after a crash. It is never sent to the server. */
  localExportDirectory?: string
  uploadId?: string
  /** Parts already accepted by storage, so an interrupted upload resumes
   *  instead of starting again. */
  uploadedParts?: { partNumber: number; etag: string }[]
  error?: string
}
