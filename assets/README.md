# Assets

Replace the placeholder PNGs with final art before shipping. Required files:

| File                          | Size           | Purpose |
|-------------------------------|----------------|---------|
| `icon.png`                    | 512×512 RGBA   | App icon source (Linux + electron-builder source) |
| `icon.ico`                    | multi-res ICO  | Windows app icon |
| `icon.icns`                   | ICNS bundle    | macOS app icon |
| `tray-icon.png`               | 32×32 (or 22×22) | System tray (white/template on macOS) |
| `tray-icon-recording.png`     | 32×32          | Tray icon when recording (red dot) |
| `sounds/start.mp3`            | short ~150ms   | Played when recording starts |
| `sounds/stop.mp3`             | short ~150ms   | Played when recording stops |

Use a tool like `electron-icon-builder` to generate `.ico` / `.icns` from a
single 1024×1024 PNG.
