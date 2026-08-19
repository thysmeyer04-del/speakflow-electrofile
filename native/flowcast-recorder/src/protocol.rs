//! The wire protocol between Electron and this recorder.
//!
//! One JSON object per line. Commands arrive on stdin, events go out on stdout.
//! Human-readable logging goes to stderr and is NEVER mixed into stdout — a
//! stray `println!` desynchronises the parser on the other side.
//!
//! Why stdin/stdout rather than a named pipe or a local socket:
//!
//!   * Lifetime coupling is free. When Electron dies, our stdin hits EOF. That
//!     is the crash signal, with no heartbeat protocol to write and no way for
//!     it to be missed.
//!   * A local socket would be reachable by every other process and every
//!     browser tab on the machine, would need a bearer token we'd have to
//!     invent, and would trigger a Windows Firewall prompt on first run — a
//!     horrible first impression for a screen recorder.
//!   * A named pipe needs an explicit ACL or anything on the box can drive the
//!     recorder. Its one advantage (reconnect after restart) is something we
//!     actively do NOT want: an orphaned recorder must finalise and die, not
//!     sit waiting for a new master.

use serde::{Deserialize, Serialize};

/// Bumped only on a breaking change. Electron refuses to talk to a version it
/// does not know.
pub const PROTOCOL_VERSION: u8 = 1;

// ── Commands (Electron -> recorder) ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    /// List monitors and microphones, and report whether this machine can
    /// actually encode H.264. Answer with `Event::Ready`.
    Probe { id: u64 },

    Start {
        id: u64,
        /// Opaque id chosen by Electron; echoed back on every event.
        session: String,
        /// Directory to write into. Must already exist.
        out_dir: String,
        #[serde(default)]
        source: Source,
        #[serde(default)]
        video: VideoOpts,
        #[serde(default)]
        audio: AudioOpts,
        /// Show the mouse pointer in the recording.
        #[serde(default = "default_true")]
        cursor: bool,
        /// If set, we exit when this process disappears. Belt and braces
        /// alongside the stdin-EOF watchdog: covers the case where a grandchild
        /// inherited our stdin handle, so EOF never arrives.
        #[serde(default)]
        parent_pid: Option<u32>,
    },

    /// Finish the MP4 cleanly and answer with `Event::Stopped`.
    Stop { id: u64 },

    /// Stop and delete the output file.
    Abort { id: u64 },
}

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// Whole screen. `index` is a position in the list returned by `probe`;
    /// omit for the primary display.
    Monitor {
        #[serde(default)]
        index: Option<usize>,
    },
}

impl Default for Source {
    fn default() -> Self {
        Source::Monitor { index: None }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct VideoOpts {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Bits per second. See `Default` below for why this number.
    pub bitrate: u32,
}

impl Default for VideoOpts {
    /// The size budget, worked backwards.
    ///
    /// Target: a five-minute recording lands around 45 MB.
    ///   1_050_000 video + 96_000 audio = 1_146_000 bits/sec
    ///   1_146_000 * 300 sec / 8 / 1024 / 1024 = 41 MB.
    ///
    /// Every one of these overrides a library default that is wrong for us:
    /// it defaults to HEVC (does not play in Firefox) at 15 Mbit/s (a 560 MB
    /// five-minute file) at 60 fps (double the size, no benefit on a screen).
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate: 1_050_000,
        }
    }
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct AudioOpts {
    #[serde(default)]
    pub mic: bool,
    /// Everything you can hear — the "system audio" or loopback channel.
    #[serde(default)]
    pub system: bool,
    #[serde(default = "default_audio_bitrate")]
    pub bitrate: u32,
}

fn default_true() -> bool {
    true
}
fn default_audio_bitrate() -> u32 {
    96_000
}

impl AudioOpts {
    pub fn any(&self) -> bool {
        self.mic || self.system
    }
}

// ── Events (recorder -> Electron) ───────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Event {
    Ready {
        id: u64,
        caps: Caps,
    },
    Ack {
        id: u64,
        cmd: &'static str,
    },
    /// Emitted as soon as the PICTURE is being captured — deliberately before
    /// microphone and system audio are up. See `capture.rs` for why.
    ///
    /// Carries the id of the `start` command that caused it, so the caller can
    /// match it to its request. Absent in standalone `--record` mode, where
    /// there was no command.
    Started {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u64>,
        session: String,
        started_at_unix_ms: u128,
        width: u32,
        height: u32,
        fps: u32,
    },
    #[allow(dead_code)]
    Stats {
        elapsed_ms: u64,
        frames: u64,
        skipped: u64,
        audio_chunks: u64,
        disk_free_mb: u64,
    },
    /// Something went wrong but the recording is continuing. Audio failures
    /// arrive this way, never as an error.
    Warn {
        code: &'static str,
        message: String,
    },
    /// `id` is absent when this was not caused by a command — which is exactly
    /// the crash case: stdin closed, so we finalised the file on our own.
    Stopped {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u64>,
        session: String,
        file: String,
        bytes: u64,
        duration_ms: u64,
        frames: u64,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u64>,
        code: &'static str,
        fatal: bool,
        message: String,
    },
}

#[derive(Debug, Serialize)]
pub struct Caps {
    pub protocol_version: u8,
    pub recorder_version: &'static str,
    /// False on Windows N/KN editions and Server installs without the Media
    /// Feature Pack — they ship no H.264 encoder at all. Detected by actually
    /// building an encoder, not by guessing from the OS version.
    pub h264_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h264_error: Option<String>,
    pub monitors: Vec<MonitorInfo>,
    pub microphones: Vec<DeviceInfo>,
}

#[derive(Debug, Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub device_name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub default: bool,
}

// ── Emitting ────────────────────────────────────────────────────────────────

/// Write one event to stdout as a single line, with the protocol version
/// stamped on it.
///
/// Takes the lock, writes, flushes. Called from the capture thread and the
/// main thread, so it must stay atomic per line.
pub fn emit(event: &Event) {
    use std::io::Write;

    let mut value = match serde_json::to_value(event) {
        Ok(v) => v,
        Err(err) => {
            log(&format!("could not serialise event: {err}"));
            return;
        }
    };
    if let Some(obj) = value.as_object_mut() {
        obj.insert("v".into(), serde_json::json!(PROTOCOL_VERSION));
    }

    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    if writeln!(handle, "{value}").is_ok() {
        let _ = handle.flush();
    }
}

/// Human-readable logging. Goes to stderr, which Electron forwards into
/// main.log — never to stdout, which is protocol-only.
pub fn log(message: &str) {
    eprintln!("[flowcast-recorder] {message}");
}
