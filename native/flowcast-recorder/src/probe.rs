//! Runtime, display and microphone capability probe.

use windows_capture::monitor::Monitor;

use crate::protocol::{Caps, DeviceInfo, MonitorInfo, PROTOCOL_VERSION};

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
        .map(|(index, monitor)| MonitorInfo {
            index,
            name: monitor
                .name()
                .unwrap_or_else(|_| format!("Display {}", index + 1)),
            device_name: monitor.device_name().unwrap_or_default(),
            width: monitor.width().unwrap_or(0),
            height: monitor.height().unwrap_or(0),
        })
        .collect()
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
