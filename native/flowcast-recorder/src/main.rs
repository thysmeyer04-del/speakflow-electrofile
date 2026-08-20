//! Flowcast screen recorder.
//!
//! A small Windows program that records the screen to an MP4. It is driven by
//! Speakflow over its input and output streams, one JSON object per line, but
//! it also runs standalone so it can be tested without Electron:
//!
//!     flowcast-recorder.exe --probe
//!     flowcast-recorder.exe --record 10 --out test.mp4 --mic --system-audio
//!
//! It has NO network access — no sockets, no HTTP, nothing. Uploading is
//! Electron's job. That keeps the login token in one place, and means an
//! unsigned program that reads your screen never trips a Windows Firewall
//! prompt, which matters a great deal for how antivirus software treats it.

// Keep the console subsystem even in release builds. The recorder's protocol
// is carried over inherited stdin/stdout pipes; compiling as a GUI subsystem
// makes those handles unreliable and can leave Electron waiting forever for a
// response. Electron launches the sidecar with `windowsHide: true`, so users
// still never see a console window.

mod audio;
mod capture;
mod ffmpeg;
mod probe;
mod protocol;

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use windows_capture::capture::{CaptureControl, GraphicsCaptureApiHandler};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use crate::capture::{CaptureState, Flags, LatestFrame, Recorder};
use crate::ffmpeg::{Runtime, VideoWorker};
use crate::protocol::{emit, log, AudioOpts, Command, Event, Source, VideoOpts};

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type Control = CaptureControl<Recorder, BoxError>;

/// Longest we wait for the encoder to come up before calling it a failure.
const START_TIMEOUT: Duration = Duration::from_secs(6);
/// Longest we wait for the MP4 to be finalised on stop. Generous: this is the
/// step that makes the file playable, and cutting it short loses the recording.
/// Roughly two seconds of 20 ms audio chunks. Bounded on purpose — see the note
/// in `capture.rs` about audio only moving when a frame arrives.
const AUDIO_CHANNEL_DEPTH: usize = 100;

/// Nothing above 1080p. A 4K screen recorded at native resolution is four times
/// the pixels for no benefit to someone watching a screen share, and it would
/// blow the file-size budget completely.
const MAX_WIDTH: u32 = 1920;
const MAX_HEIGHT: u32 = 1080;

fn main() {
    install_panic_hook();

    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|a| a == "--probe") {
        let caps = probe::probe();
        emit(&Event::Ready { id: 0, caps });
        return;
    }

    if let Some(seconds) = flag_value(&args, "--record").and_then(|v| v.parse::<u64>().ok()) {
        std::process::exit(run_standalone(&args, seconds));
    }

    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return;
    }

    run_server();
}

// ── Standalone test mode ────────────────────────────────────────────────────

/// `--record N` — record for N seconds and exit. This is the mode used to
/// answer the question everything else depends on: do the picture and the sound
/// stay together over a long recording?
fn run_standalone(args: &[String], seconds: u64) -> i32 {
    let out = flag_value(args, "--out").unwrap_or_else(|| "flowcast-test.mp4".to_string());
    let out_path = PathBuf::from(&out);

    let mut video = VideoOpts::default();
    if let Some(fps) = flag_value(args, "--fps").and_then(|v| v.parse().ok()) {
        video.fps = fps;
    }
    if let Some(bitrate) = flag_value(args, "--bitrate").and_then(|v| v.parse().ok()) {
        video.bitrate = bitrate;
    }

    let audio = AudioOpts {
        mic: args.iter().any(|a| a == "--mic"),
        system: args.iter().any(|a| a == "--system-audio"),
        bitrate: 96_000,
    };

    let source = Source::Monitor {
        index: flag_value(args, "--monitor").and_then(|v| v.parse().ok()),
    };
    let cursor = !args.iter().any(|a| a == "--no-cursor");

    log(&format!(
        "recording {seconds}s to {} (mic: {}, system audio: {})",
        out_path.display(),
        audio.mic,
        audio.system
    ));

    let session = match start_session("standalone", &out_path, source, video, audio, cursor, None) {
        Ok(session) => session,
        Err(message) => {
            log(&format!("could not start: {message}"));
            return 1;
        }
    };

    let level = session.audio.as_ref().map(|a| a.level());
    log(&format!(
        "recording at {}x{} {} fps{}",
        session.width,
        session.height,
        session.fps,
        level.map(|_| ", audio on").unwrap_or_default()
    ));

    // Progress on stderr so stdout stays protocol-only even here.
    for elapsed in 1..=seconds {
        std::thread::sleep(Duration::from_secs(1));
        if elapsed % 5 == 0 || elapsed == seconds {
            log(&format!("  {elapsed}/{seconds}s"));
        }
    }

    match stop_session(session, false) {
        Ok(stopped) => {
            let mb = stopped.bytes as f64 / 1024.0 / 1024.0;
            log(&format!(
                "done: {} — {:.1} MB, {} frames over {:.1}s",
                stopped.file,
                mb,
                stopped.frames,
                stopped.duration_ms as f64 / 1000.0
            ));
            emit(&stopped.event(None));
            0
        }
        Err(message) => {
            log(&format!("stop failed: {message}"));
            1
        }
    }
}

// ── Server mode (driven by Electron) ────────────────────────────────────────

fn run_server() {
    let mut session: Option<Session> = None;
    let stdin = std::io::stdin();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                log(&format!("stdin read failed: {err}"));
                break;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let command: Command = match serde_json::from_str(line) {
            Ok(command) => command,
            Err(err) => {
                emit(&Event::Error {
                    id: None,
                    code: "bad_command",
                    fatal: false,
                    message: format!("could not understand that command: {err}"),
                });
                continue;
            }
        };

        match command {
            Command::Probe { id } => {
                emit(&Event::Ready {
                    id,
                    caps: probe::probe(),
                });
            }

            Command::Start {
                id,
                session: session_id,
                out_dir,
                source,
                video,
                audio,
                cursor,
                parent_pid,
            } => {
                if session.is_some() {
                    emit(&Event::Error {
                        id: Some(id),
                        code: "already_recording",
                        fatal: false,
                        message: "a recording is already in progress".into(),
                    });
                    continue;
                }
                emit(&Event::Ack { id, cmd: "start" });

                let out_path = Path::new(&out_dir).join("recording.mp4");
                if let Some(parent) = out_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }

                match start_session(
                    &session_id,
                    &out_path,
                    source,
                    video,
                    audio,
                    cursor,
                    parent_pid,
                ) {
                    Ok(started) => {
                        emit(&Event::Started {
                            // Carries the command id so the caller can match
                            // this to the `start` it sent.
                            id: Some(id),
                            session: started.session_id.clone(),
                            started_at_unix_ms: unix_ms(),
                            width: started.width,
                            height: started.height,
                            fps: started.fps,
                        });
                        session = Some(started);
                    }
                    Err(message) => emit(&Event::Error {
                        id: Some(id),
                        code: "start_failed",
                        fatal: true,
                        message,
                    }),
                }
            }

            Command::Stop { id } | Command::Abort { id } => {
                let discard = matches!(command, Command::Abort { .. });
                emit(&Event::Ack {
                    id,
                    cmd: if discard { "abort" } else { "stop" },
                });

                match session.take() {
                    Some(active) => match stop_session(active, discard) {
                        Ok(stopped) => emit(&stopped.event(Some(id))),
                        Err(message) => emit(&Event::Error {
                            id: Some(id),
                            code: "stop_failed",
                            fatal: true,
                            message,
                        }),
                    },
                    None => emit(&Event::Error {
                        id: Some(id),
                        code: "not_recording",
                        fatal: false,
                        message: "nothing is being recorded".into(),
                    }),
                }
            }

            Command::Pause { id } | Command::Resume { id } => {
                let paused = matches!(command, Command::Pause { .. });
                match session.as_mut() {
                    Some(active) => {
                        active.paused.store(paused, Ordering::Release);
                        emit(&Event::Paused {
                            id,
                            session: active.session_id.clone(),
                            paused,
                        });
                    }
                    None => emit(&Event::Error {
                        id: Some(id),
                        code: "not_recording",
                        fatal: false,
                        message: "nothing is being recorded".into(),
                    }),
                }
            }
        }
    }

    // stdin closed. This is the crash path: Electron has died, or is quitting
    // without telling us. Finalise whatever is in flight so the recording is
    // still playable and can be uploaded next time Speakflow starts. This
    // costs nothing and is the whole reason recording survives an Electron
    // crash.
    if let Some(active) = session.take() {
        log("input stream closed — finalising the recording before exiting");
        match stop_session(active, false) {
            // No id: nobody asked for this. Electron has gone.
            Ok(stopped) => emit(&stopped.event(None)),
            Err(message) => log(&format!("could not finalise: {message}")),
        }
    }
}

// ── Session lifecycle ───────────────────────────────────────────────────────

struct Session {
    session_id: String,
    out_path: PathBuf,
    video_path: PathBuf,
    pcm_path: Option<PathBuf>,
    width: u32,
    height: u32,
    fps: u32,
    audio_bitrate: u32,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    state: Arc<CaptureState>,
    control: Option<Control>,
    runtime: Runtime,
    video_worker: Option<VideoWorker>,
    audio_writer: Option<JoinHandle<Result<u64, String>>>,
    audio: Option<audio::AudioCapture>,
}

struct Stopped {
    file: String,
    bytes: u64,
    duration_ms: u64,
    frames: u64,
    session: String,
}

impl Stopped {
    /// `id` is the command that asked for the stop, or None when stdin closed
    /// and we finalised on our own.
    fn event(&self, id: Option<u64>) -> Event {
        Event::Stopped {
            id,
            session: self.session.clone(),
            file: self.file.clone(),
            bytes: self.bytes,
            duration_ms: self.duration_ms,
            frames: self.frames,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn start_session(
    session_id: &str,
    out_path: &Path,
    source: Source,
    mut video: VideoOpts,
    audio_opts: AudioOpts,
    cursor: bool,
    parent_pid: Option<u32>,
) -> Result<Session, String> {
    let Source::Monitor { index } = source;

    let monitor = match index {
        Some(index) => Monitor::enumerate()
            .map_err(|err| format!("could not list monitors: {err}"))?
            .into_iter()
            .nth(index)
            .ok_or_else(|| format!("there is no monitor {index}"))?,
        None => Monitor::primary().map_err(|err| format!("no primary monitor: {err}"))?,
    };

    // Fit the monitor into our size ceiling. A 4K display becomes 1920x1080
    // rather than being recorded at four times the data for no benefit.
    let native_width = monitor.width().unwrap_or(MAX_WIDTH);
    let native_height = monitor.height().unwrap_or(MAX_HEIGHT);
    let (fitted_width, fitted_height) = fit_within(native_width, native_height);
    video.width = fitted_width;
    video.height = fitted_height;

    let runtime = ffmpeg::resolve_runtime()?;
    ffmpeg::probe_h264(&runtime)?;

    let stop = Arc::new(AtomicBool::new(false));
    let paused = Arc::new(AtomicBool::new(false));
    let state = Arc::new(CaptureState::default());
    let latest: LatestFrame = Arc::new(Mutex::new(None));
    let video_path = temporary_path(out_path, "video.tmp.mp4");
    let _ = std::fs::remove_file(&video_path);

    let video_worker = ffmpeg::start_video(
        runtime.clone(),
        video_path.clone(),
        native_width,
        native_height,
        video.width,
        video.height,
        video.fps,
        video.bitrate,
        latest.clone(),
        stop.clone(),
        paused.clone(),
        state.clone(),
    )?;

    // Audio channel is created up front but the capture threads are started
    // AFTER the picture is recording — see below.
    let flags = Flags {
        latest,
        stop: stop.clone(),
        state: state.clone(),
        fps: video.fps,
    };

    let settings = Settings::new(
        monitor,
        if cursor {
            CursorCaptureSettings::WithCursor
        } else {
            CursorCaptureSettings::WithoutCursor
        },
        // NOTE: Windows draws a yellow border around whatever is being
        // captured. `WithoutBorder` needs a capability only Microsoft Store
        // apps can be granted, and Speakflow ships as a normal installer — so
        // asking for it here would simply fail. Left at Default deliberately.
        // If the border proves unacceptable, the fallback is DXGI Desktop
        // Duplication, which has no border.
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        // VideoEncoder declares its Direct3D input stream as BGRA8. Passing
        // RGBA8 surfaces works until Media Foundation finalizes the transcode,
        // then fails with E_FAIL and leaves a zero-byte MP4.
        ColorFormat::Bgra8,
        flags,
    );

    let control = match Recorder::start_free_threaded(settings) {
        Ok(control) => control,
        Err(err) => {
            stop.store(true, Ordering::Release);
            let _ = video_worker.finish();
            let _ = std::fs::remove_file(&video_path);
            return Err(format!("capture failed: {err}"));
        }
    };

    // Wait for the encoder to exist, or for the capture thread to report why
    // it could not be created.
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(message) = state.take_error() {
            stop.store(true, Ordering::Release);
            let _ = control.stop();
            let _ = video_worker.finish();
            let _ = std::fs::remove_file(&video_path);
            return Err(message);
        }
        if state.ready.load(Ordering::Acquire) {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !state.ready.load(Ordering::Acquire) {
        stop.store(true, Ordering::Release);
        let _ = control.stop();
        let _ = video_worker.finish();
        let _ = std::fs::remove_file(&video_path);
        return Err("the recorder did not start in time".into());
    }

    // ── Audio starts here, and only here ────────────────────────────────────
    //
    // The picture is already recording. Sound is started afterwards,
    // fire-and-forget, and its failure is a warning rather than an error. This
    // mirrors the pattern already proven in Speakflow's dictation recorder,
    // where a failed audio worklet only disables live streaming and never kills
    // the dictation. A screen recording without sound is disappointing; a
    // screen recording that refused to start is a lost meeting.
    let mut pcm_path = None;
    let mut audio_writer = None;
    let audio_handle = if audio_opts.any() {
        let (tx, rx) = sync_channel(AUDIO_CHANNEL_DEPTH);
        let candidate = temporary_path(out_path, "audio.tmp.pcm");
        let _ = std::fs::remove_file(&candidate);
        match ffmpeg::start_pcm_writer(candidate.clone(), rx, paused.clone(), state.clone()) {
            Ok(writer) => {
                pcm_path = Some(candidate);
                audio_writer = Some(writer);
                match audio::start(audio_opts.mic, audio_opts.system, tx) {
                    Ok(handle) => Some(handle),
                    Err(err) => {
                        emit(&Event::Warn {
                            code: "audio_unavailable",
                            message: format!("recording without sound: {err}"),
                        });
                        None
                    }
                }
            }
            Err(err) => {
                emit(&Event::Warn {
                    code: "audio_unavailable",
                    message: format!("recording without sound: {err}"),
                });
                None
            }
        }
    } else {
        None
    };

    if let Some(pid) = parent_pid {
        watch_parent(pid, stop.clone());
    }

    Ok(Session {
        session_id: session_id.to_string(),
        out_path: out_path.to_path_buf(),
        video_path,
        pcm_path,
        width: video.width,
        height: video.height,
        fps: video.fps,
        audio_bitrate: audio_opts.bitrate,
        stop,
        paused,
        state,
        control: Some(control),
        runtime,
        video_worker: Some(video_worker),
        audio_writer,
        audio: audio_handle,
    })
}

fn stop_session(mut session: Session, discard: bool) -> Result<Stopped, String> {
    if let Some(audio) = session.audio.take() {
        audio.stop();
    }

    // Ask the capture thread to finalise on its next frame.
    session.stop.store(true, Ordering::Release);

    // If frames stopped arriving — a completely motionless screen, or a monitor
    // that went away — the handler never got the chance to finalise. Ending the
    // capture session drops the handler, and its `Drop` writes the index. This
    // is why `Recorder` implements `Drop`.
    if let Some(control) = session.control.take() {
        let _ = control.stop();
    }

    let video_result = session
        .video_worker
        .take()
        .ok_or_else(|| "the video worker was missing".to_string())?
        .finish();
    let audio_result = session.audio_writer.take().map(|writer| {
        writer
            .join()
            .map_err(|_| "the audio writer thread panicked".to_string())?
    });

    let frames = session.state.frames.load(Ordering::Relaxed);
    let skipped = session.state.skipped.load(Ordering::Relaxed);
    let audio_chunks = session.state.audio_chunks.load(Ordering::Relaxed);
    log(&format!(
        "session counters before final validation: {frames} frames, {skipped} skipped, {audio_chunks} audio chunks"
    ));

    if discard {
        let _ = std::fs::remove_file(&session.out_path);
        let _ = std::fs::remove_file(&session.video_path);
        let _ = std::fs::remove_file(recovery_metadata_path(&session.out_path));
        if let Some(path) = &session.pcm_path {
            let _ = std::fs::remove_file(path);
        }
        return Ok(Stopped {
            file: String::new(),
            bytes: 0,
            duration_ms: frames.saturating_mul(1_000) / u64::from(session.fps.max(1)),
            frames: 0,
            session: session.session_id,
        });
    }

    let video_result = video_result?;
    if video_result.frames != frames {
        log(&format!(
            "video worker returned {} frames; shared counter returned {frames}",
            video_result.frames
        ));
    }
    if let Some(result) = audio_result {
        if let Err(message) = result {
            emit(&Event::Warn {
                code: "audio_unavailable",
                message: format!("recording saved without complete sound: {message}"),
            });
            session.pcm_path = None;
        }
    }
    if let Some(message) = session.state.take_error() {
        return Err(message);
    }

    let info = ffmpeg::mux_recording(
        &session.runtime,
        &session.video_path,
        session.pcm_path.as_deref(),
        &session.out_path,
        session.audio_bitrate,
        video_result.duration_seconds,
    )?;

    let _ = std::fs::remove_file(&session.video_path);
    if let Some(path) = &session.pcm_path {
        let _ = std::fs::remove_file(path);
    }

    let bytes = std::fs::metadata(&session.out_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if bytes == 0 {
        return Err("the recording came out empty".into());
    }

    let duration_ms = (info.duration_seconds * 1_000.0).round() as u64;
    let file = session.out_path.to_string_lossy().to_string();
    write_recovery_metadata(
        &session.out_path,
        bytes,
        duration_ms,
        frames,
        info.width,
        info.height,
    )?;

    Ok(Stopped {
        file,
        bytes,
        duration_ms,
        frames,
        session: session.session_id,
    })
}

fn temporary_path(final_path: &Path, suffix: &str) -> PathBuf {
    let stem = final_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("recording");
    final_path.with_file_name(format!("{stem}.{suffix}"))
}

fn recovery_metadata_path(final_path: &Path) -> PathBuf {
    final_path.with_file_name("recording.meta.json")
}

fn write_recovery_metadata(
    final_path: &Path,
    bytes: u64,
    duration_ms: u64,
    frames: u64,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let target = recovery_metadata_path(final_path);
    let temporary = target.with_extension("json.tmp");
    let value = serde_json::json!({
        "v": 1,
        "file": final_path.to_string_lossy(),
        "bytes": bytes,
        "durationMs": duration_ms,
        "frames": frames,
        "width": width,
        "height": height,
    });
    std::fs::write(&temporary, format!("{}\n", value))
        .map_err(|err| format!("could not save recovery metadata: {err}"))?;
    std::fs::rename(&temporary, &target)
        .map_err(|err| format!("could not commit recovery metadata: {err}"))
}

// ── Windows odds and ends ───────────────────────────────────────────────────

/// Exit when the process that launched us disappears.
///
/// Belt and braces alongside the stdin-EOF path in `run_server`. EOF covers
/// almost everything, but if a grandchild process inherited our input handle it
/// never arrives, and we would record forever. This catches that.
fn watch_parent(pid: u32, stop: Arc<AtomicBool>) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE,
    };

    let _ = std::thread::Builder::new()
        .name("flowcast-parent-watch".into())
        .spawn(move || unsafe {
            let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
                log("could not watch the parent process");
                return;
            };
            WaitForSingleObject(handle, INFINITE);
            let _ = CloseHandle(handle);
            log("the program that started us has gone — stopping");
            stop.store(true, Ordering::Release);
        });
}

/// Scale down to fit inside 1920x1080, keeping the shape of the screen.
/// H.264 needs even numbers, so both are rounded down to even.
fn fit_within(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (MAX_WIDTH, MAX_HEIGHT);
    }
    let (mut w, mut h) = if width <= MAX_WIDTH && height <= MAX_HEIGHT {
        (width, height)
    } else {
        let scale = f64::min(
            MAX_WIDTH as f64 / width as f64,
            MAX_HEIGHT as f64 / height as f64,
        );
        (
            (width as f64 * scale).round() as u32,
            (height as f64 * scale).round() as u32,
        )
    };
    w -= w % 2;
    h -= h % 2;
    (w.max(2), h.max(2))
}

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        // Panics MUST go to stderr. A panic message on stdout would be parsed
        // as a protocol event and desynchronise Electron's reader.
        log(&format!("PANIC: {info}"));
    }));
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn print_help() {
    eprintln!(
        r#"Flowcast recorder {version}

  --probe                  List monitors and microphones, and check whether this
                           machine can encode H.264 at all.

  --record <seconds>       Record and exit. For testing without Electron.
    --out <path>           Where to write (default: flowcast-test.mp4)
    --monitor <index>      Which screen (default: the main one)
    --fps <n>              Frames per second (default: 30)
    --bitrate <bits>       Video bitrate (default: 1050000, ~45 MB for 5 min)
    --mic                  Record the microphone
    --system-audio         Record everything you can hear
    --no-cursor            Leave the mouse pointer out

  With no arguments, reads JSON commands from its input stream — this is how
  Speakflow drives it.
"#,
        version = env!("CARGO_PKG_VERSION")
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_preserves_native_sizes_under_the_ceiling() {
        assert_eq!(fit_within(1280, 720), (1280, 720));
    }

    #[test]
    fn fit_scales_four_k_to_full_hd() {
        assert_eq!(fit_within(3840, 2160), (1920, 1080));
    }

    #[test]
    fn fit_returns_even_dimensions() {
        let (width, height) = fit_within(1365, 767);
        assert_eq!(width % 2, 0);
        assert_eq!(height % 2, 0);
    }

    #[test]
    fn protocol_start_command_uses_safe_defaults() {
        let command: Command = serde_json::from_str(
            r#"{"cmd":"start","id":7,"session":"test","out_dir":"C:\\recording"}"#,
        )
        .expect("valid start command");

        match command {
            Command::Start {
                id,
                video,
                audio,
                cursor,
                ..
            } => {
                assert_eq!(id, 7);
                assert_eq!(video.fps, 30);
                assert_eq!(video.bitrate, 1_050_000);
                assert!(!audio.any());
                assert!(cursor);
            }
            _ => panic!("expected start command"),
        }
    }
}
