//! Microphone and system-audio capture, mixed into one mono stream for the
//! encoder.
//!
//! Two things here are deliberate and worth understanding before changing
//! anything.
//!
//! **1. Audio can never fail a recording.** Every function in this module
//! reports failure by returning an error that the caller turns into a warning.
//! The picture keeps recording, silently. This copies a pattern already proven
//! in Speakflow's dictation recorder (`src/recorder/recorder.ts`), where a
//! failed audio worklet only disables live streaming and never kills the
//! dictation.
//!
//! **2. Silence keeps its real duration.** A monotonic 20 ms pacer writes the
//! output timeline even when a WASAPI device stops delivering silent buffers.
//! The source rings absorb the tiny clock difference between audio hardware and
//! the system clock, preventing silence from shortening the finished video.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use crate::ffmpeg::AUDIO_SAMPLE_RATE;
use crate::protocol::log;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// 20 ms of 48 kHz mono — 960 samples, 1920 bytes once converted to 16-bit.
///
/// Small enough that the tail of a recording loses almost nothing, large enough
/// that we are not calling into the encoder thousands of times a second.
const CHUNK_SAMPLES: usize = (AUDIO_SAMPLE_RATE as usize / 1000) * 20;

/// How long one source may starve before we treat it as silent and carry on
/// without it. Stops a dead microphone from muting the system audio too.
const CHUNK_DURATION: Duration = Duration::from_millis(20);

/// When both sources are mixed, the system audio is pulled back so a voiceover
/// stays intelligible over whatever is playing. Same instinct as every
/// screen-recording tool: the person talking is the point.
const SYSTEM_GAIN_WHEN_MIXED: f32 = 0.7;

/// A source's samples waiting to be mixed. Mono f32 at 48 kHz.
type Ring = Arc<Mutex<VecDeque<f32>>>;

pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    /// Peak level of the last mixed chunk, times 1000, for a level meter.
    level: Arc<AtomicU32>,
}

impl AudioCapture {
    /// Signal every thread to wind up. Does not block: the encoder drains
    /// whatever is left in the channel when it finalises.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }

    /// Peak level 0.0–1.0 of the most recent mixed chunk.
    pub fn level(&self) -> f32 {
        self.level.load(Ordering::Relaxed) as f32 / 1000.0
    }
}

/// Start capturing.
///
/// Spawns one thread per enabled source plus one mixer thread, and returns a
/// handle for stopping them. Sends 16-bit little-endian mono PCM at 48 kHz down
/// `sink` — exactly what the encoder was configured to expect in `encode.rs`.
///
/// Call this AFTER the picture is already recording. If it returns an error, the
/// caller emits a warning and the recording continues without sound.
pub fn start(mic: bool, system: bool, sink: SyncSender<Vec<u8>>) -> Result<AudioCapture, BoxError> {
    if !mic && !system {
        return Err("no audio source requested".into());
    }

    // COM must be initialised on every thread that touches WASAPI. Doing it
    // here as well as in each thread is harmless and guards against ordering
    // surprises.
    initialize_mta()
        .ok()
        .map_err(|err| format!("could not initialise Windows audio: {err:?}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let level = Arc::new(AtomicU32::new(0));

    let mic_ring: Option<Ring> = mic.then(|| Arc::new(Mutex::new(VecDeque::new())));
    let system_ring: Option<Ring> = system.then(|| Arc::new(Mutex::new(VecDeque::new())));

    if let Some(ring) = mic_ring.clone() {
        spawn_source("mic", Direction::Capture, ring, stop.clone());
    }
    if let Some(ring) = system_ring.clone() {
        // Select the default playback endpoint. `capture_loop` then initializes
        // that render endpoint for capture, which activates WASAPI loopback.
        spawn_source("system", Direction::Render, ring, stop.clone());
    }

    spawn_mixer(mic_ring, system_ring, sink, stop.clone(), level.clone());

    Ok(AudioCapture { stop, level })
}

/// One capture thread per device. Pushes mono f32 into `ring`.
fn spawn_source(label: &'static str, direction: Direction, ring: Ring, stop: Arc<AtomicBool>) {
    let _ = thread::Builder::new()
        .name(format!("flowcast-audio-{label}"))
        .spawn(move || {
            if let Err(err) = capture_loop(label, direction, &ring, &stop) {
                // Deliberately a log line, not a fatal error. See the module
                // comment: sound never takes the recording down.
                log(&format!("{label} audio stopped: {err}"));
            }
        });
}

fn capture_loop(
    label: &str,
    direction: Direction,
    ring: &Ring,
    stop: &AtomicBool,
) -> Result<(), BoxError> {
    initialize_mta()
        .ok()
        .map_err(|err| format!("COM init failed: {err:?}"))?;

    let enumerator = DeviceEnumerator::new()?;
    let device = enumerator.get_default_device(&direction)?;
    let name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "unknown device".to_string());
    log(&format!("{label} audio: {name}"));

    let mut audio_client = device.get_iaudioclient()?;

    // Ask for 32-bit float stereo at 48 kHz. `autoconvert: true` makes Windows
    // resample and remix for us, so a mono 44.1 kHz microphone still works
    // without any conversion code here.
    let format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        AUDIO_SAMPLE_RATE as usize,
        2,
        None,
    );
    let channels = 2usize;

    let (_default_period, min_period) = audio_client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    // The endpoint is chosen with `direction`, but every source here is being
    // captured. Passing Capture for a Render endpoint is what makes WASAPI set
    // AUDCLNT_STREAMFLAGS_LOOPBACK; passing Render opens playback mode and
    // get_audiocaptureclient then fails with AUDCLNT_E_WRONG_ENDPOINT_TYPE.
    audio_client.initialize_client(&format, &Direction::Capture, &mode)?;

    let event = audio_client.set_get_eventhandle()?;
    let capture_client = audio_client.get_audiocaptureclient()?;
    audio_client.start_stream()?;

    let mut bytes: VecDeque<u8> = VecDeque::with_capacity(1 << 16);

    while !stop.load(Ordering::Acquire) {
        capture_client.read_from_device_to_deque(&mut bytes)?;

        // Interleaved f32 -> mono f32, averaging the channels.
        let frame_bytes = 4 * channels;
        if bytes.len() >= frame_bytes {
            let frames = bytes.len() / frame_bytes;
            if let Ok(mut ring) = ring.lock() {
                for _ in 0..frames {
                    let mut sum = 0.0f32;
                    for _ in 0..channels {
                        let mut raw = [0u8; 4];
                        for slot in raw.iter_mut() {
                            *slot = bytes.pop_front().unwrap_or(0);
                        }
                        sum += f32::from_le_bytes(raw);
                    }
                    ring.push_back(sum / channels as f32);
                }

                // Never let a stalled mixer grow this without bound. Two
                // seconds is far more than the mixer should ever be behind.
                let cap = AUDIO_SAMPLE_RATE as usize * 2;
                while ring.len() > cap {
                    ring.pop_front();
                }
            }
        }

        // A timeout here is not fatal on its own — a silent microphone still
        // signals — but repeated timeouts mean the device has gone.
        if event.wait_for_event(3000).is_err() {
            log(&format!("{label} audio: device stopped signalling"));
            break;
        }
    }

    let _ = audio_client.stop_stream();
    Ok(())
}

/// Mixes the enabled sources into 20 ms chunks of 16-bit mono PCM.
///
/// Driven by how much data the sound cards have actually produced, not by a
/// timer — see the module comment.
fn spawn_mixer(
    mic_ring: Option<Ring>,
    system_ring: Option<Ring>,
    sink: SyncSender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) {
    let both = mic_ring.is_some() && system_ring.is_some();

    let _ = thread::Builder::new()
        .name("flowcast-audio-mix".into())
        .spawn(move || {
            let mut next_chunk = Instant::now();

            while !stop.load(Ordering::Acquire) {
                let mut mixed = vec![0.0f32; CHUNK_SAMPLES];
                drain_into(&mic_ring, &mut mixed, 1.0);
                drain_into(
                    &system_ring,
                    &mut mixed,
                    if both { SYSTEM_GAIN_WHEN_MIXED } else { 1.0 },
                );

                let mut peak = 0.0f32;
                let mut pcm = Vec::with_capacity(CHUNK_SAMPLES * 2);
                for sample in &mixed {
                    let clamped = sample.clamp(-1.0, 1.0);
                    peak = peak.max(clamped.abs());
                    pcm.extend_from_slice(&((clamped * i16::MAX as f32) as i16).to_le_bytes());
                }
                level.store((peak * 1000.0) as u32, Ordering::Relaxed);

                // A full channel means the encoder is not draining — which
                // happens when frames have stopped arriving because nothing on
                // screen is changing. Drop the chunk rather than blocking the
                // mixer, and let the caller warn. Better a gap in the sound
                // than a stalled recording.
                let _ = sink.try_send(pcm);

                next_chunk += CHUNK_DURATION;
                let now = Instant::now();
                if next_chunk > now {
                    thread::sleep(next_chunk - now);
                } else if now.duration_since(next_chunk) > CHUNK_DURATION {
                    next_chunk = now;
                }
            }
            log("audio mixer finished");
        });
}

/// True when this source has a full chunk waiting, or has starved long enough
/// that we should stop waiting for it and treat it as silence.
/// Adds up to `out.len()` samples from `ring` into `out`, applying `gain`.
/// Anything missing is left as silence.
fn drain_into(ring: &Option<Ring>, out: &mut [f32], gain: f32) {
    let Some(ring) = ring else { return };
    let Ok(mut ring) = ring.lock() else { return };
    for slot in out.iter_mut() {
        match ring.pop_front() {
            Some(sample) => *slot += sample * gain,
            None => break,
        }
    }
}
