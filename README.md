# Speakflow Desktop

Electron desktop application — voice-to-text powered by Groq Whisper. Loads the
Speakflow Dashboard (sibling Vite + React app) as its main UI and provides:

- Global hotkey for push-to-talk recording (default: Ctrl+Win / Ctrl+Cmd)
- Microphone capture via a hidden renderer window (getUserMedia + MediaRecorder)
- Whisper transcription via Groq (`whisper-large-v3`)
- Text injection into whichever app is currently focused
- System tray icon, floating recording overlay, auto-updater

## Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in GROQ_API_KEY in .env

# 3. Start the dashboard (sibling folder)
cd "../Speakflow Dashboard" && npm run dev
# Vite serves at http://localhost:5173

# 4. Start the desktop app
npm run dev
```

## Build

```bash
npm run build:win    # Windows NSIS installer
npm run build:mac    # macOS DMG (arm64 + x64)
npm run build:linux  # AppImage
```

## Architecture

See [the plan](../../.claude/plans/take-the-folloing-plan-smooth-muffin.md)
for the full build plan (Three-Brain + 5-Agent protocol).

```
src/
├── main/       Electron main process (Node)
├── preload/    contextBridge API exposed to the dashboard
├── recorder/   Hidden window: MediaRecorder
└── overlay/    Floating recording indicator
```

## Operating Protocol

This repo is built under the **Three-Brain protocol**:

- **Claude** builds and implements
- **Codex** reviews every diff (`git diff | codex exec`)
- **Gemini** handles repo-wide context scans

No code is "done" until it passes a Codex audit. Every commit message
references the Codex audit result (PASS / FINDINGS-resolved).
