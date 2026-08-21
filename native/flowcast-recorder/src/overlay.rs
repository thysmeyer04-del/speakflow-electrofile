//! Bounded real-time camera, ink, and click composition.
//!
//! Electron owns camera permission and the visible preview. The recorder only
//! receives small JPEG frames plus normalized layout/ink commands, then burns
//! them into BGRA before FFmpeg sees a frame. This keeps window capture and
//! monitor capture behavior identical while the visible Electron helpers can
//! be excluded from screen capture.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::imageops::FilterType;

use crate::protocol::{CameraSize, InkColor, OverlayPoint};

const MAX_CAMERA_BASE64_BYTES: usize = 700_000;
const CAMERA_SIDE: u32 = 360;
const MAX_STROKES: usize = 48;
const MAX_POINTS_PER_STROKE: usize = 512;
const INK_LIFETIME: Duration = Duration::from_secs(5);
const CLICK_LIFETIME: Duration = Duration::from_millis(750);

#[derive(Clone, Copy)]
pub struct CaptureBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

struct CameraFrame {
    pixels: Vec<u8>,
    side: u32,
}

#[derive(Clone, Copy)]
struct CameraLayout {
    visible: bool,
    x: f32,
    y: f32,
    size: CameraSize,
}

struct Stroke {
    color: (u8, u8, u8),
    width: u8,
    points: Vec<OverlayPoint>,
    created: Instant,
}

struct ClickMark {
    point: OverlayPoint,
    created: Instant,
}

struct Inner {
    camera: Option<CameraFrame>,
    layout: CameraLayout,
    strokes: Vec<Stroke>,
    clicks: Vec<ClickMark>,
}

pub struct OverlayState {
    inner: Mutex<Inner>,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                camera: None,
                layout: CameraLayout {
                    visible: false,
                    x: 0.14,
                    y: 0.82,
                    size: CameraSize::Small,
                },
                strokes: Vec::new(),
                clicks: Vec::new(),
            }),
        }
    }
}

impl OverlayState {
    pub fn has_visuals(&self) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            (inner.layout.visible && inner.camera.is_some())
                || !inner.strokes.is_empty()
                || !inner.clicks.is_empty()
        })
    }

    pub fn set_camera_layout(
        &self,
        visible: bool,
        x: f32,
        y: f32,
        size: CameraSize,
    ) -> Result<(), String> {
        if !x.is_finite() || !y.is_finite() {
            return Err("camera coordinates must be finite".into());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "overlay state was poisoned")?;
        inner.layout = CameraLayout {
            visible,
            x: x.clamp(0.0, 1.0),
            y: y.clamp(0.0, 1.0),
            size,
        };
        Ok(())
    }

    pub fn set_camera_frame(&self, encoded: &str) -> Result<(), String> {
        if encoded.len() > MAX_CAMERA_BASE64_BYTES {
            return Err("camera frame exceeded the size limit".into());
        }
        let bytes = BASE64_STANDARD
            .decode(encoded)
            .map_err(|_| "camera frame was not valid base64".to_string())?;
        let decoded = image::load_from_memory(&bytes)
            .map_err(|err| format!("camera JPEG could not be decoded: {err}"))?
            .to_rgba8();
        let square =
            image::imageops::resize(&decoded, CAMERA_SIDE, CAMERA_SIDE, FilterType::Triangle);
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "overlay state was poisoned")?;
        inner.camera = Some(CameraFrame {
            pixels: square.into_raw(),
            side: CAMERA_SIDE,
        });
        Ok(())
    }

    pub fn add_stroke(
        &self,
        color: InkColor,
        width: u8,
        points: Vec<OverlayPoint>,
    ) -> Result<(), String> {
        if points.len() < 2 || points.len() > MAX_POINTS_PER_STROKE {
            return Err("ink strokes must contain between 2 and 512 points".into());
        }
        if points
            .iter()
            .any(|point| !point.x.is_finite() || !point.y.is_finite())
        {
            return Err("ink coordinates must be finite".into());
        }
        let color = match color {
            InkColor::Red => (255, 70, 82),
            InkColor::Yellow => (255, 214, 70),
            InkColor::Green => (70, 220, 135),
            InkColor::Blue => (74, 151, 255),
            InkColor::White => (255, 255, 255),
        };
        let points = points
            .into_iter()
            .map(|point| OverlayPoint {
                x: point.x.clamp(0.0, 1.0),
                y: point.y.clamp(0.0, 1.0),
            })
            .collect();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "overlay state was poisoned")?;
        if inner.strokes.len() >= MAX_STROKES {
            inner.strokes.remove(0);
        }
        inner.strokes.push(Stroke {
            color,
            width: width.clamp(2, 18),
            points,
            created: Instant::now(),
        });
        Ok(())
    }

    pub fn clear_ink(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.strokes.clear();
        }
    }

    pub fn add_click(&self, point: OverlayPoint) {
        if !point.x.is_finite() || !point.y.is_finite() {
            return;
        }
        if let Ok(mut inner) = self.inner.lock() {
            inner.clicks.push(ClickMark {
                point: OverlayPoint {
                    x: point.x.clamp(0.0, 1.0),
                    y: point.y.clamp(0.0, 1.0),
                },
                created: Instant::now(),
            });
            if inner.clicks.len() > 12 {
                inner.clicks.remove(0);
            }
        }
    }

    pub fn composite(&self, frame: &mut [u8], width: u32, height: u32) {
        let expected = width as usize * height as usize * 4;
        if frame.len() != expected || width == 0 || height == 0 {
            return;
        }
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let now = Instant::now();
        inner
            .strokes
            .retain(|stroke| now.duration_since(stroke.created) < INK_LIFETIME);
        inner
            .clicks
            .retain(|click| now.duration_since(click.created) < CLICK_LIFETIME);

        for stroke in &inner.strokes {
            let age = now.duration_since(stroke.created).as_secs_f32();
            let alpha = if age <= 4.2 {
                0.94
            } else {
                ((5.0 - age) / 0.8).clamp(0.0, 1.0) * 0.94
            };
            draw_stroke(frame, width, height, stroke, alpha);
        }
        for click in &inner.clicks {
            let progress = (now.duration_since(click.created).as_secs_f32()
                / CLICK_LIFETIME.as_secs_f32())
            .clamp(0.0, 1.0);
            draw_click(frame, width, height, click.point, progress);
        }
        if inner.layout.visible {
            if let Some(camera) = &inner.camera {
                draw_camera(frame, width, height, camera, inner.layout);
            }
        }
    }
}

pub fn start_click_watcher(
    overlay: Arc<OverlayState>,
    bounds: CaptureBounds,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("flowcast-click-highlight".into())
        .spawn(move || {
            use windows::Win32::Foundation::POINT;
            use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
            use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

            let mut was_down = false;
            while !stop.load(Ordering::Acquire) {
                let down = unsafe { GetAsyncKeyState(VK_LBUTTON.0.into()) } < 0;
                if down && !was_down && !paused.load(Ordering::Acquire) {
                    let mut point = POINT::default();
                    if unsafe { GetCursorPos(&mut point).is_ok() }
                        && point.x >= bounds.x
                        && point.y >= bounds.y
                        && point.x < bounds.x.saturating_add(bounds.width as i32)
                        && point.y < bounds.y.saturating_add(bounds.height as i32)
                    {
                        overlay.add_click(OverlayPoint {
                            x: (point.x - bounds.x) as f32 / bounds.width.max(1) as f32,
                            y: (point.y - bounds.y) as f32 / bounds.height.max(1) as f32,
                        });
                    }
                }
                was_down = down;
                thread::sleep(Duration::from_millis(8));
            }
        })
        .map_err(|err| format!("could not start click highlighting: {err}"))
}

fn draw_camera(
    frame: &mut [u8],
    width: u32,
    height: u32,
    camera: &CameraFrame,
    layout: CameraLayout,
) {
    let fraction = match layout.size {
        CameraSize::Small => 0.16,
        CameraSize::Medium => 0.23,
        CameraSize::Large => 0.31,
    };
    let diameter = ((width.min(height) as f32 * fraction).round() as i32).clamp(72, 520);
    let radius = diameter as f32 / 2.0;
    let center_x = (layout.x * width as f32).clamp(radius + 3.0, width as f32 - radius - 3.0);
    let center_y = (layout.y * height as f32).clamp(radius + 3.0, height as f32 - radius - 3.0);
    let left = (center_x - radius).round() as i32;
    let top = (center_y - radius).round() as i32;

    for dy in 0..diameter {
        let y = top + dy;
        if y < 0 || y >= height as i32 {
            continue;
        }
        for dx in 0..diameter {
            let x = left + dx;
            if x < 0 || x >= width as i32 {
                continue;
            }
            let rel_x = dx as f32 + 0.5 - radius;
            let rel_y = dy as f32 + 0.5 - radius;
            let distance = (rel_x * rel_x + rel_y * rel_y).sqrt();
            if distance > radius {
                continue;
            }
            if distance > radius - 3.0 {
                blend_bgra(frame, width, x, y, (255, 255, 255), 0.92);
                continue;
            }
            let source_x = ((dx as u32 * camera.side) / diameter as u32).min(camera.side - 1);
            let source_y = ((dy as u32 * camera.side) / diameter as u32).min(camera.side - 1);
            let source = ((source_y * camera.side + source_x) * 4) as usize;
            let rgba = &camera.pixels[source..source + 4];
            blend_bgra(
                frame,
                width,
                x,
                y,
                (rgba[0], rgba[1], rgba[2]),
                rgba[3] as f32 / 255.0,
            );
        }
    }
}

fn draw_stroke(frame: &mut [u8], width: u32, height: u32, stroke: &Stroke, alpha: f32) {
    let scale = (width.min(height) as f32 / 1080.0).clamp(0.55, 2.0);
    let radius = ((stroke.width as f32 * scale) / 2.0).round().max(1.0) as i32;
    for pair in stroke.points.windows(2) {
        let from = (
            (pair[0].x * (width.saturating_sub(1)) as f32).round() as i32,
            (pair[0].y * (height.saturating_sub(1)) as f32).round() as i32,
        );
        let to = (
            (pair[1].x * (width.saturating_sub(1)) as f32).round() as i32,
            (pair[1].y * (height.saturating_sub(1)) as f32).round() as i32,
        );
        let steps = (to.0 - from.0).abs().max((to.1 - from.1).abs()).max(1);
        for step in 0..=steps {
            let t = step as f32 / steps as f32;
            let x = (from.0 as f32 + (to.0 - from.0) as f32 * t).round() as i32;
            let y = (from.1 as f32 + (to.1 - from.1) as f32 * t).round() as i32;
            draw_disc(frame, width, height, x, y, radius, stroke.color, alpha);
        }
    }
}

fn draw_click(frame: &mut [u8], width: u32, height: u32, point: OverlayPoint, progress: f32) {
    let x = (point.x * (width.saturating_sub(1)) as f32).round() as i32;
    let y = (point.y * (height.saturating_sub(1)) as f32).round() as i32;
    let scale = (width.min(height) as f32 / 1080.0).clamp(0.6, 2.0);
    let radius = ((8.0 + progress * 28.0) * scale).round() as i32;
    let thickness = (4.0 * scale).round().max(2.0) as i32;
    let alpha = (1.0 - progress).powf(0.7) * 0.85;
    for py in y - radius - thickness..=y + radius + thickness {
        if py < 0 || py >= height as i32 {
            continue;
        }
        for px in x - radius - thickness..=x + radius + thickness {
            if px < 0 || px >= width as i32 {
                continue;
            }
            let dx = px - x;
            let dy = py - y;
            let distance = ((dx * dx + dy * dy) as f32).sqrt();
            if (distance - radius as f32).abs() <= thickness as f32 {
                blend_bgra(frame, width, px, py, (255, 103, 71), alpha);
            }
        }
    }
}

fn draw_disc(
    frame: &mut [u8],
    width: u32,
    height: u32,
    center_x: i32,
    center_y: i32,
    radius: i32,
    color: (u8, u8, u8),
    alpha: f32,
) {
    let radius_squared = radius * radius;
    for y in center_y - radius..=center_y + radius {
        if y < 0 || y >= height as i32 {
            continue;
        }
        for x in center_x - radius..=center_x + radius {
            if x < 0 || x >= width as i32 {
                continue;
            }
            let dx = x - center_x;
            let dy = y - center_y;
            if dx * dx + dy * dy <= radius_squared {
                blend_bgra(frame, width, x, y, color, alpha);
            }
        }
    }
}

fn blend_bgra(frame: &mut [u8], width: u32, x: i32, y: i32, color: (u8, u8, u8), alpha: f32) {
    let index = ((y as u32 * width + x as u32) * 4) as usize;
    if index + 3 >= frame.len() {
        return;
    }
    let alpha = alpha.clamp(0.0, 1.0);
    let inverse = 1.0 - alpha;
    frame[index] = (frame[index] as f32 * inverse + color.2 as f32 * alpha).round() as u8;
    frame[index + 1] = (frame[index + 1] as f32 * inverse + color.1 as f32 * alpha).round() as u8;
    frame[index + 2] = (frame[index + 2] as f32 * inverse + color.0 as f32 * alpha).round() as u8;
    frame[index + 3] = 255;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ink_is_composited_and_then_expires() {
        let overlay = OverlayState::default();
        overlay
            .add_stroke(
                InkColor::Red,
                7,
                vec![
                    OverlayPoint { x: 0.1, y: 0.1 },
                    OverlayPoint { x: 0.9, y: 0.9 },
                ],
            )
            .unwrap();
        let mut frame = vec![0u8; 160 * 90 * 4];
        overlay.composite(&mut frame, 160, 90);
        assert!(frame.iter().any(|value| *value != 0));

        if let Ok(mut inner) = overlay.inner.lock() {
            inner.strokes[0].created = Instant::now() - Duration::from_secs(6);
        }
        let mut expired = vec![0u8; 160 * 90 * 4];
        overlay.composite(&mut expired, 160, 90);
        assert!(expired.iter().all(|value| *value == 0));
    }

    #[test]
    fn malformed_overlay_inputs_fail_closed() {
        let overlay = OverlayState::default();
        assert!(overlay
            .set_camera_layout(true, f32::NAN, 0.5, CameraSize::Small)
            .is_err());
        assert!(overlay
            .add_stroke(InkColor::Blue, 7, vec![OverlayPoint { x: 0.5, y: 0.5 }],)
            .is_err());
        assert!(overlay.set_camera_frame("not-base64").is_err());
    }
}
