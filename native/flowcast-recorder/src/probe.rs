//! Runtime, display and microphone capability probe.

use windows_capture::monitor::Monitor;
use windows_capture::window::Window;

use crate::protocol::{Caps, DeviceInfo, MonitorInfo, WindowInfo, PROTOCOL_VERSION};

pub fn probe() -> Caps {
    let (h264_available, h264_error) = match check_h264() {
        Ok(()) => (true, None),
        Err(message) => (false, Some(message)),
    };

    Caps {
        protocol_version: PROTOCOL_VERSION,
        recorder_version: env!("CARGO_PKG_VERSION"),
        h264_available,
        h264_error,
        monitors: monitors(),
        windows: windows(),
        microphones: microphones(),
    }
}

fn monitors() -> Vec<MonitorInfo> {
    let Ok(found) = Monitor::enumerate() else {
        crate::protocol::log("could not list monitors");
        return Vec::new();
    };

    found
        .into_iter()
        .enumerate()
        .map(|(index, monitor)| {
            let (x, y) = monitor_origin(&monitor).unwrap_or((0, 0));
            MonitorInfo {
                index,
                name: monitor
                    .name()
                    .unwrap_or_else(|_| format!("Display {}", index + 1)),
                device_name: monitor.device_name().unwrap_or_default(),
                width: monitor.width().unwrap_or(0),
                height: monitor.height().unwrap_or(0),
                x,
                y,
            }
        })
        .collect()
}

fn monitor_origin(monitor: &Monitor) -> Option<(i32, i32)> {
    use std::mem;
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};

    let mut info = MONITORINFO {
        cbSize: u32::try_from(mem::size_of::<MONITORINFO>()).ok()?,
        ..MONITORINFO::default()
    };
    let handle = HMONITOR(monitor.as_raw_hmonitor());
    if unsafe { GetMonitorInfoW(handle, &mut info).as_bool() } {
        Some((info.rcMonitor.left, info.rcMonitor.top))
    } else {
        None
    }
}

fn windows() -> Vec<WindowInfo> {
    let Ok(found) = Window::enumerate() else {
        crate::protocol::log("could not list capturable windows");
        return Vec::new();
    };

    found
        .into_iter()
        .enumerate()
        .filter_map(|(index, window)| {
            let title = window.title().ok()?.trim().to_string();
            if title.is_empty() {
                return None;
            }
            let (x, y, width, height) = window_capture_rect(&window)?;
            if width < 160 || height < 120 {
                return None;
            }
            Some(WindowInfo {
                index,
                title,
                process_name: window.process_name().unwrap_or_default(),
                width,
                height,
                x,
                y,
            })
        })
        .collect()
}

/// The windows-capture crate removes the title bar from window frames. Match
/// its effective content rectangle so Electron's camera/ink helpers align with
/// the pixels that are actually encoded.
pub fn window_capture_rect(window: &Window) -> Option<(i32, i32, u32, u32)> {
    use std::mem;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};

    let mut rect = RECT::default();
    let hwnd = HWND(window.as_raw_hwnd());
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut std::ffi::c_void,
            u32::try_from(mem::size_of::<RECT>()).ok()?,
        )
        .ok()?;
    }
    let title_height = i32::try_from(window.title_bar_height().ok()?).ok()?;
    let top = rect.top.saturating_add(title_height).min(rect.bottom - 1);
    Some((
        rect.left,
        top,
        u32::try_from((rect.right - rect.left).max(1)).ok()?,
        u32::try_from((rect.bottom - top).max(1)).ok()?,
    ))
}

fn microphones() -> Vec<DeviceInfo> {
    use wasapi::{initialize_mta, DeviceEnumerator, Direction};

    if initialize_mta().ok().is_err() {
        return Vec::new();
    }

    let Ok(enumerator) = DeviceEnumerator::new() else {
        return Vec::new();
    };

    let default_id = enumerator
        .get_default_device(&Direction::Capture)
        .ok()
        .and_then(|device| device.get_id().ok());

    let Ok(collection) = enumerator.get_device_collection(&Direction::Capture) else {
        return Vec::new();
    };
    let count = collection.get_nbr_devices().unwrap_or(0);

    (0..count)
        .filter_map(|index| collection.get_device_at_index(index).ok())
        .filter_map(|device| {
            let id = device.get_id().ok()?;
            let name = device
                .get_friendlyname()
                .unwrap_or_else(|_| "Microphone".to_string());
            let is_default = default_id.as_deref() == Some(id.as_str());
            Some(DeviceInfo {
                id,
                name,
                default: is_default,
            })
        })
        .collect()
}

fn check_h264() -> Result<(), String> {
    let runtime = crate::ffmpeg::resolve_runtime()?;
    crate::ffmpeg::probe_h264(&runtime)
}
