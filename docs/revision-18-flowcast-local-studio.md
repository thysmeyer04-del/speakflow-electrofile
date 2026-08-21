# Speakflow Revision 18 — Flowcast Local Studio

Status: **FROZEN FOR IMPLEMENTATION**

Frozen: 2026-08-21 (Africa/Johannesburg)

Release target: **Speakflow 0.10.0 Windows beta**

## 1. Outcome

Flowcast becomes a local-first Loom-style recorder inside Speakflow. The user
chooses one save folder when enabling Flowcast, and every validated MP4 is saved
there until the user changes the folder in Settings. The folder may be local,
external, or OneDrive-synced. A local recording does not call the Flowcast API,
Supabase, Cloudflare, or another video server.

## 2. Frozen product decisions

- Enabling Flowcast without a saved destination opens the native folder picker.
  Cancelling leaves Flowcast disabled.
- The selected folder is remembered. It is changed only from Settings.
- The active product mode is named **Local folder**, not OneDrive test mode.
- The completion action is **Show file**. There is no in-app Play action.
- Capture targets in this release are a whole monitor or an individual window.
- Custom-area capture is the first explicitly committed follow-up after this
  release; it must not be forgotten or silently removed from the roadmap.
- Camera is optional. Its bubble is circular, draggable, and has small, medium,
  and large sizes that can be changed before or during recording.
- The drawing tool has multiple colors and thicknesses. Strokes are burned into
  the final video and disappear after five seconds.
- Mouse-click highlighting is optional and burned into the final video.
- Recording controls remain visible to the user but are excluded from the
  captured output.

## 3. Recording workflow

1. The user presses **Record screen**.
2. Flowcast opens a pre-record panel with the capture target, camera, microphone,
   computer audio, cursor, click-highlight, quality, and destination summary.
3. The user starts a three-second countdown.
4. A protected control palette and optional protected camera preview appear.
5. Pause/resume, stop/save, discard, quick restart, camera, camera size, drawing
   color/thickness, and clear-ink actions remain available during recording.
6. Flowcast finalizes and validates the MP4, then atomically publishes it to the
   configured destination and offers **Show file**.

## 4. Native architecture

- Windows Graphics Capture continues to feed BGRA frames to the constant-rate
  pacer and FFmpeg `h264_mf` encoder.
- The source protocol supports monitor and window targets.
- The native capability probe returns monitors, capturable windows,
  microphones, and H.264 availability. Electron requests camera access only
  when the user enables the camera bubble and fails safely if it is denied.
- Electron owns camera permission and preview. It sends bounded camera frames
  and normalized overlay state to the network-isolated Rust sidecar.
- The sidecar composites the camera circle, five-second strokes, and click
  ripples into BGRA frames before encoding, so output is identical for monitor
  and window capture.
- Electron control, preview, and drawing windows use Windows capture exclusion;
  only the sidecar-composited overlays enter the video.
- All overlay protocol inputs are size-, rate-, coordinate-, and color-bounded.

## 5. Local storage contract

- The configured destination must be an absolute directory and must pass a
  writable probe before enablement or recording.
- At least 2 GiB free is required at start on both the working and destination
  volumes when free-space information is available.
- Recording continues in the private working directory and reaches the selected
  folder only after MP4 validation, flush, and atomic rename/copy.
- Crash recovery remembers the exact destination and never uploads a local
  recording.
- Existing `onedrive` settings/manifests migrate compatibly to `local`.

## 6. Verification gates

- Folder selection is mandatory on first activation and persists across restart.
- Local, OneDrive, and removable-drive destinations pass save and Show-file tests.
- Monitor and window recordings validate as non-empty H.264/AAC MP4s.
- Camera on/off, all three sizes, dragging, drawing fade, and click highlights
  are visibly present in final output.
- Control/setup windows never appear in the final output.
- Permission denial, camera removal, target-window closure, low disk, pause,
  discard, app crash, and restart recovery fail safely.
- Ten-minute audio/video drift remains within 100 ms.
- Desktop tests, typecheck, Rust build/tests, dashboard lint/build, installer,
  and installed-app smoke checks pass before publishing 0.10.0.

## 7. Committed next revision

Revision 19 starts with custom-area recording, including high-DPI multi-monitor
selection, keyboard cancellation, minimum dimensions, and exact coordinate
mapping for camera, ink, cursor, and click highlights. It follows Revision 18's
production verification and is not optional scope.
