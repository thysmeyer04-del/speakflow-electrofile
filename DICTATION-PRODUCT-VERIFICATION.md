# Dictation product update — 2026-09-21

Version: 0.10.2. Companion UI changes are in the FlowSpeak dashboard repository.

## Implemented

- Verbatim, Clean and Rewrite preferences, with protected-detail checks retained. Present-tense agreement corrections now survive the short-sentence sanity check.
- Email, messaging, code and other-app writing styles selected from the existing app/window-title classification.
- Fast cleanup deadline (1.2 seconds) and balanced deadline (2.5 seconds); original text remains the fallback. Streaming transcription remains the default.
- Encrypted local original/output comparisons, per signed-in owner, capped at 100 entries and 24 hours. Copy either version, delete comparisons, disable retention. Entries longer than 30,000 characters per version are visibly marked as limited comparisons.
- Owner-scoped remembered word/phrase corrections, literal and nonrecursive, with removal controls. Corrections remain on this computer; existing cloud dictionary and pronunciation tools remain available.
- Windows hold-to-talk using the reserved global shortcut and a small native key-release monitor. Toggle remains the default; unsupported shortcuts/platforms cannot select Hold.
- Voice Edit in free shortcut slot 4: select text, start instruction recording, speak an edit, stop with the same shortcut. Revalidate selection and target before replacement; failed edits retain the selected text.
- Offline cleanup executes explicit paragraph, line and list commands without an AI formatter. Combined Local transcription + Offline cleanup refuses cloud ASR fallback. Local worker crashes no longer silently switch the transcription-mode setting to Cloud. This is not a fully offline account/history system or local AI rewriting.

## Evidence

- 121 desktop tests pass, including preference validation, owner isolation, retention controls, literal corrections, short grammar corrections, offline list preservation and Voice Edit startup.
- Desktop TypeScript and native helper build pass. Dashboard TypeScript/Vite production build passes.
- Controlled Electron UI fixture renders the actual settings and review components; selecting Verbatim persists across rerender. Screenshots inspected for layout and original/output readability.
- Native clipboard fixture: 9/9 fields passed, including textarea, rich text, shadow DOM, iframe, delayed clipboard read, and 9,600-character output. An old clipboard sentinel was seeded before each test. Dispatch times: 213–278 ms on this machine; this measures insertion, not transcription/model latency.
- Actual Windows Notepad: exact text verified by selecting/copying the inserted result. Numbered list, bullets, paragraphs, invoice 48219, R250, and negation survived; no stale clipboard value appeared. A separate test file was used.

## Remaining acceptance checks

- Actual email-client insertion and live English audio through the released build.
- Hold-to-talk recording/release lifecycle on the user's keyboard. The native test was stopped at its focus precondition rather than injecting into an unrelated window.
- Matched recordings across competitors and production latency/accuracy measurements. No parity or perfect-accuracy claim is made.
- Context currently uses process and window title, not surrounding email threads or screenshots. Offline cleanup is explicit formatting, not model-based grammar inference. Automatic correction harvesting is not implemented; learning requires the user's explicit saved correction.

## Run checks

`npm test`, `npm run build:hold`, `npm run build:ts`, `npm run build:assets`.

With the isolated test window focused: `node scripts/run-native-paste.mjs`.

Actual Notepad fixture: `node scripts/run-native-paste.mjs scripts/verify-notepad.cjs`.

New UI requires both the updated dashboard and desktop. Older desktop versions show an update-required message instead of nonfunctional controls.
