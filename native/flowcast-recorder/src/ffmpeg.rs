//! Pinned FFmpeg runtime integration.
//!
//! `windows-capture` remains responsible for Windows Graphics Capture, but its
//! MediaTranscoder-backed encoder is not reliable on every supported Windows
//! build. We feed paced BGRA frames to a separately packaged LGPL FFmpeg build
//! and ask Windows Media Foundation to encode H.264/AAC (`h264_mf`/`aac_mf`).

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::capture::{CaptureState, LatestFrame};
use crate::overlay::OverlayState;
pub const AUDIO_SAMPLE_RATE: u32 = 48_000;

#[derive(Clone, Debug)]
pub struct Runtime {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

#[derive(Debug)]
pub struct MediaInfo {
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub video_codec: String,
    pub audio_codec: Option<String>,
}

pub struct VideoWorker {
    join: JoinHandle<Result<VideoResult, String>>,
}

impl VideoWorker {
    pub fn finish(self) -> Result<VideoResult, String> {
        self.join
            .join()
            .map_err(|_| "the video encoder thread panicked".to_string())?
    }
}

#[derive(Debug)]
pub struct VideoResult {
    pub frames: u64,
    /// Wall-clock time from the first frame accepted by FFmpeg until stop.
    /// Raw pipe throughput can be a little below the declared input frame rate;
    /// finalization uses this duration to correct timestamps without re-encoding.
    pub duration_seconds: f64,
}

pub fn resolve_runtime() -> Result<Runtime, String> {
    let mut roots = Vec::new();

    if let Ok(dir) = std::env::var("FLOWCAST_FFMPEG_DIR") {
        if !dir.trim().is_empty() {
            roots.push(PathBuf::from(dir));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("ffmpeg"));
            roots.push(parent.to_path_buf());
        }
    }

    for root in roots {
        let ffmpeg = root.join("ffmpeg.exe");
        let ffprobe = root.join("ffprobe.exe");
        if ffmpeg.is_file() && ffprobe.is_file() {
            return Ok(Runtime { ffmpeg, ffprobe });
        }
    }

    // Development fallback only. Packaged builds always resolve the runtime
    // beside the recorder, so they never depend on a machine-wide install.
    if command_works("ffmpeg", &["-version"]) && command_works("ffprobe", &["-version"]) {
        return Ok(Runtime {
            ffmpeg: PathBuf::from("ffmpeg"),
            ffprobe: PathBuf::from("ffprobe"),
        });
    }

    Err("the packaged LGPL FFmpeg runtime is missing".into())
}

pub fn probe_h264(runtime: &Runtime) -> Result<(), String> {
    let path = std::env::temp_dir().join(format!(
        "flowcast-h264-probe-{}-{}.mp4",
        std::process::id(),
        unix_nonce()
    ));

    let output = Command::new(&runtime.ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x180:r=10:d=0.2",
            "-c:v",
            "h264_mf",
            "-b:v",
            "300k",
            "-an",
        ])
        .arg(&path)
        .output()
        .map_err(|err| format!("could not launch the H.264 probe: {err}"))?;

    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let _ = fs::remove_file(&path);

    if !output.status.success() || size == 0 {
        return Err(format!(
            "Windows H.264 encoder probe failed: {}",
            stderr_tail(&output.stderr)
        ));
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn start_video(
    runtime: Runtime,
    path: PathBuf,
    input_width: u32,
    input_height: u32,
    output_width: u32,
    output_height: u32,
    fps: u32,
    bitrate: u32,
    latest: LatestFrame,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    state: Arc<CaptureState>,
    overlay: Arc<OverlayState>,
) -> Result<VideoWorker, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("could not create the recording folder: {err}"))?;
    }

    let filter = format!("scale={output_width}:{output_height}:flags=bilinear,format=nv12");
    let size = format!("{input_width}x{input_height}");
    let fps_text = fps.max(1).to_string();
    let bitrate_text = bitrate.max(200_000).to_string();
    let keyframe_text = fps.max(1).saturating_mul(2).to_string();

    let mut child = Command::new(&runtime.ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pixel_format",
            "bgra",
            "-video_size",
            &size,
            "-framerate",
            &fps_text,
            "-i",
            "pipe:0",
            "-vf",
            &filter,
            "-c:v",
            "h264_mf",
            "-b:v",
            &bitrate_text,
            "-g",
            &keyframe_text,
            "-movflags",
            "+faststart",
            "-an",
        ])
        .arg(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("could not start the video encoder: {err}"))?;

    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| "the video encoder did not expose its input pipe".to_string())?;

    let join = thread::Builder::new()
        .name("flowcast-video-pacer".into())
        .spawn(move || {
            let frame_interval = Duration::from_nanos(1_000_000_000 / u64::from(fps.max(1)));
            let expected_bytes = input_width as usize * input_height as usize * 4;
            let mut next_frame = Instant::now();
            let mut frames = 0u64;
            let mut timeline_started: Option<Instant> = None;
            let mut failure: Option<String> = None;

            while !stop.load(Ordering::Acquire) {
                if paused.load(Ordering::Acquire) {
                    // Keep the encoder timeline compact: a five-minute pause
                    // must not create five minutes of duplicated frames.
                    next_frame = Instant::now();
                    thread::sleep(Duration::from_millis(20));
                    continue;
                }
                let current = match latest.lock() {
                    Ok(slot) => slot.clone(),
                    Err(_) => {
                        failure = Some("the latest-frame buffer was poisoned".into());
                        break;
                    }
                };

                let Some(frame) = current else {
                    next_frame = Instant::now();
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };

                if frame.len() != expected_bytes {
                    failure = Some(format!(
                        "captured frame has {} bytes; expected {expected_bytes}",
                        frame.len()
                    ));
                    break;
                }

                let composited;
                let output = if overlay.has_visuals() {
                    composited = {
                        let mut pixels = frame.as_slice().to_vec();
                        overlay.composite(&mut pixels, input_width, input_height);
                        pixels
                    };
                    composited.as_slice()
                } else {
                    frame.as_slice()
                };

                if let Err(err) = input.write_all(output) {
                    failure = Some(format!("the video encoder stopped accepting frames: {err}"));
                    break;
                }

                timeline_started.get_or_insert_with(Instant::now);
                frames += 1;
                state.frames.store(frames, Ordering::Relaxed);
                state.ready.store(true, Ordering::Release);

                next_frame += frame_interval;
                let now = Instant::now();
                if next_frame > now {
                    thread::sleep(next_frame - now);
                } else {
                    // Do not burst stale frames after a stall. Resume from now.
                    next_frame = now;
                }
            }

            let duration_seconds = frames as f64 / f64::from(fps.max(1));
            drop(input);
            let output = child
                .wait_with_output()
                .map_err(|err| format!("could not wait for the video encoder: {err}"))?;

            if failure.is_none() && !output.status.success() {
                failure = Some(format!(
                    "the video encoder failed: {}",
                    stderr_tail(&output.stderr)
                ));
            }

            if failure.is_none() && fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) == 0 {
                failure = Some("the video encoder produced an empty file".into());
            }

            state.finished.store(true, Ordering::Release);

            if let Some(message) = failure {
                state.set_error(message.clone());
                Err(message)
            } else {
                Ok(VideoResult {
                    frames,
                    duration_seconds,
                })
            }
        })
        .map_err(|err| format!("could not start the frame pacer: {err}"))?;

    Ok(VideoWorker { join })
}

pub fn start_pcm_writer(
    path: PathBuf,
    rx: Receiver<Vec<u8>>,
    paused: Arc<AtomicBool>,
    state: Arc<CaptureState>,
) -> Result<JoinHandle<Result<u64, String>>, String> {
    let file = File::create(&path)
        .map_err(|err| format!("could not create the temporary audio file: {err}"))?;

    thread::Builder::new()
        .name("flowcast-pcm-writer".into())
        .spawn(move || {
            let mut writer = BufWriter::new(file);
            let mut bytes = 0u64;
            while let Ok(chunk) = rx.recv() {
                if paused.load(Ordering::Acquire) {
                    continue;
                }
                writer
                    .write_all(&chunk)
                    .map_err(|err| format!("could not save recorded audio: {err}"))?;
                bytes += chunk.len() as u64;
                state.audio_chunks.fetch_add(1, Ordering::Relaxed);
            }
            writer
                .flush()
                .map_err(|err| format!("could not finish recorded audio: {err}"))?;
            Ok(bytes)
        })
        .map_err(|err| format!("could not start the audio writer: {err}"))
}

pub fn mux_recording(
    runtime: &Runtime,
    video_path: &Path,
    pcm_path: Option<&Path>,
    final_path: &Path,
    audio_bitrate: u32,
    video_duration_seconds: f64,
) -> Result<MediaInfo, String> {
    if final_path.exists() {
        fs::remove_file(final_path)
            .map_err(|err| format!("could not replace the previous recording: {err}"))?;
    }

    let pcm_bytes = pcm_path
        .and_then(|path| fs::metadata(path).ok())
        .map(|meta| meta.len())
        .unwrap_or(0);

    let encoded = inspect(runtime, video_path)?;
    if encoded.duration_seconds <= 0.0 || video_duration_seconds <= 0.0 {
        return Err("the temporary recording has no usable timeline".into());
    }
    let timestamp_scale = (video_duration_seconds / encoded.duration_seconds).clamp(0.5, 2.0);
    let timestamp_scale_text = format!("{timestamp_scale:.9}");

    if pcm_bytes > 0 {
        let pcm = pcm_path.expect("pcm path exists when pcm bytes are non-zero");
        let bitrate = audio_bitrate.max(64_000).to_string();
        let output = Command::new(&runtime.ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-itsscale",
                &timestamp_scale_text,
                "-i",
            ])
            .arg(video_path)
            .args(["-f", "s16le", "-ar", "48000", "-ac", "1", "-i"])
            .arg(pcm)
            .args([
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "copy",
                "-c:a",
                "aac_mf",
                "-b:a",
                &bitrate,
                "-shortest",
                "-avoid_negative_ts",
                "make_zero",
                "-movflags",
                "+faststart",
            ])
            .arg(final_path)
            .output()
            .map_err(|err| format!("could not launch the audio/video muxer: {err}"))?;

        if !output.status.success() {
            return Err(format!(
                "could not combine the video and audio: {}",
                stderr_tail(&output.stderr)
            ));
        }
    } else {
        let output = Command::new(&runtime.ffmpeg)
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-itsscale",
                &timestamp_scale_text,
                "-i",
            ])
            .arg(video_path)
            .args([
                "-map",
                "0:v:0",
                "-c:v",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                "-movflags",
                "+faststart",
            ])
            .arg(final_path)
            .output()
            .map_err(|err| format!("could not launch the video finalizer: {err}"))?;

        if !output.status.success() {
            return Err(format!(
                "could not finalize the silent recording: {}",
                stderr_tail(&output.stderr)
            ));
        }
    }

    let info = inspect(runtime, final_path)?;
    if info.video_codec != "h264"
        || info.duration_seconds <= 0.0
        || info.width == 0
        || info.height == 0
        || (pcm_bytes > 0 && info.audio_codec.as_deref() != Some("aac"))
    {
        return Err("the finished recording failed media validation".into());
    }

    Ok(info)
}

pub fn inspect(runtime: &Runtime, path: &Path) -> Result<MediaInfo, String> {
    let output = Command::new(&runtime.ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-show_entries",
            "stream=codec_name,codec_type,width,height",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|err| format!("could not inspect the finished recording: {err}"))?;

    if !output.status.success() {
        return Err(format!(
            "the finished recording could not be inspected: {}",
            stderr_tail(&output.stderr)
        ));
    }

    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("ffprobe returned invalid JSON: {err}"))?;
    let streams = value
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| "ffprobe returned no media streams".to_string())?;
    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
        .ok_or_else(|| "the recording contains no video stream".to_string())?;
    let audio_codec = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .and_then(|stream| stream.get("codec_name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let duration_seconds = value
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);

    Ok(MediaInfo {
        duration_seconds,
        width: video.get("width").and_then(Value::as_u64).unwrap_or(0) as u32,
        height: video.get("height").and_then(Value::as_u64).unwrap_or(0) as u32,
        video_codec: video
            .get("codec_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        audio_codec,
    })
}

fn command_works(command: &str, args: &[&str]) -> bool {
    Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn stderr_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).trim().to_string();
    if text.is_empty() {
        return "no diagnostic was returned".into();
    }
    let mut chars = text.chars().rev().take(2_000).collect::<Vec<_>>();
    chars.reverse();
    chars.into_iter().collect()
}

fn unix_nonce() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}
