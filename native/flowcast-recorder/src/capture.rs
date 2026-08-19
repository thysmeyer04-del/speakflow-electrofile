//! Windows Graphics Capture frame producer.
//!
//! This module deliberately does not encode. It copies at most `fps` BGRA
//! frames per second into one shared "latest frame" slot. The FFmpeg pacer owns
//! the clock, reads that slot at a constant rate, duplicates static frames and
//! drops superseded frames. Audio therefore never depends on screen activity.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

pub type LatestFrame = Arc<Mutex<Option<Arc<Vec<u8>>>>>;

#[derive(Default)]
pub struct CaptureState {
    /// Set by the video pacer after FFmpeg has accepted its first full frame.
    pub ready: AtomicBool,
    /// Set after FFmpeg has exited and finalized the temporary MP4.
    pub finished: AtomicBool,
    /// Frames written to FFmpeg, including deliberate duplicates on a static
    /// screen. This is the output timeline, not the WGC callback count.
    pub frames: AtomicU64,
    /// WGC frames skipped by the producer-side rate limiter.
    pub skipped: AtomicU64,
    pub audio_chunks: AtomicU64,
    pub error: Mutex<Option<String>>,
}

impl CaptureState {
    pub fn set_error(&self, message: String) {
        crate::protocol::log(&format!("capture error: {message}"));
        if let Ok(mut slot) = self.error.lock() {
            if slot.is_none() {
                *slot = Some(message);
            }
        }
    }

    pub fn take_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|mut slot| slot.take())
    }
}

pub struct Flags {
    pub latest: LatestFrame,
    pub stop: Arc<AtomicBool>,
    pub state: Arc<CaptureState>,
    pub fps: u32,
}

pub struct Recorder {
    latest: LatestFrame,
    stop: Arc<AtomicBool>,
    state: Arc<CaptureState>,
    frame_interval: Duration,
    last_copied: Option<Instant>,
    padding: Vec<u8>,
    copied: u64,
}

impl GraphicsCaptureApiHandler for Recorder {
    type Flags = Flags;
    type Error = BoxError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;
        let fps = flags.fps.clamp(1, 60);
        Ok(Self {
            latest: flags.latest,
            stop: flags.stop,
            state: flags.state,
            frame_interval: Duration::from_nanos(1_000_000_000 / u64::from(fps)),
            last_copied: None,
            padding: Vec::new(),
            copied: 0,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.stop.load(Ordering::Acquire) {
            capture_control.stop();
            return Ok(());
        }

        let now = Instant::now();
        if self
            .last_copied
            .is_some_and(|previous| now.duration_since(previous) < self.frame_interval)
        {
            self.state.skipped.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
        self.last_copied = Some(now);

        if self.copied == 0 {
            crate::protocol::log(&format!(
                "first frame: {}x{}, {:?}",
                frame.width(),
                frame.height(),
                frame.color_format()
            ));
        }

        let frame_bytes = {
            let buffer = frame.buffer().map_err(|err| {
                let message = format!("could not copy a captured frame: {err}");
                self.state.set_error(message.clone());
                message
            })?;
            Arc::new(buffer.as_nopadding_buffer(&mut self.padding).to_vec())
        };

        match self.latest.lock() {
            Ok(mut slot) => *slot = Some(frame_bytes),
            Err(_) => {
                let message = "the latest-frame buffer was poisoned".to_string();
                self.state.set_error(message.clone());
                return Err(message.into());
            }
        }
        self.copied += 1;
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        crate::protocol::log("capture item closed; stopping the encoder");
        self.stop.store(true, Ordering::Release);
        Ok(())
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
