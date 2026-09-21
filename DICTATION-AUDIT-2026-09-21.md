# Speakflow dictation audit — 2026-09-21

## Scope and acceptance status

Windows desktop dictation in English, insertion into Notepad/email/editor fields,
and Email / Prompt Engineer / Polish shortcuts. The user specifically reports
failed insertion and old clipboard text being pasted. The marketing repository
was inspected only for the API that implements app functionality, not its design.

**Implemented and automated-tested; native acceptance remains open.** This is
not a claim of perfect transcription, universal insertion, or verified Wispr Flow
parity. No new release has been published and the running installed app was not
replaced. The candidate installer is built separately as `0.10.1-audit.1`.

Desktop source: `thysmeyer04-del/speakflow-electrofile`, based on fetched main
`5b7bc6e`, branch `codex/dictation-reliability-audit`.
API source: `thysmeyer04-del/speakflow-marketing`, branch
`codex/transform-integrity-audit`, based on `d5a8105`.
The first fetch used the active Lean Living account and failed. A scoped fetch
using the existing personal account succeeded: `origin/master` is `342a05b`;
the two intervening commits only update AGENTS.md/CLAUDE.md, not runtime code.
The worktree is `C:/Users/ThysMeyer/Documents/Speakflow App/speakflow-marketing`;
the new local branch has no upstream, with the API route and its new validator/tests
changed and existing untracked `supabase/` preserved. No merge/deployment was done.
Dashboard remote verified as `thysmeyer04-del/FlowSpeak`; no dashboard changes.
Existing worktrees and untracked Supabase directories were preserved.

## Findings and implemented fixes

| Priority | Finding | Change |
|---|---|---|
| Critical | Old clipboard restored 120 ms after Ctrl+V, before a slow target might read it | Keep dictated text on the clipboard by default; serialize paste consumption for 500 ms without delaying dispatch acknowledgement |
| Critical | Failed paste still restored old clipboard, losing manual recovery | Failed paste retains result; session-local recovery via Alt+Shift+Z and tray Copy/Paste last output |
| High | Transform pasted into whatever window/selection happened to be active after the model call | Compare native window identity and title, re-copy and compare the selection before replacement; retain changed-target output for recovery |
| High | Clipboard capture and ordinary injection had independent queues | Shared clipboard transaction queue; capture restores promptly before the network request |
| High | New clipboard content could be overwritten by delayed restoration | Ownership check before optional restore; clipboard changes immediately before paste stop insertion |
| High | Unknown current focus allowed insertion when an old target existed | Unknown current focus fails to clipboard recovery |
| High | Repeated transform hotkeys queued multiple rewrites | Single-flight from selection capture through replacement; repeat events ignored |
| High | Cancellation covered model call but not selection probing or queued paste | Cancellation spans capture/model/injection; new recording, logout, owner change and recovery invalidate stale work |
| High | Built-in email and prompt transforms bypassed fact-preservation guards | Check numbers, URLs, emails, negation, personal dictionary; Polish also uses statistical content-preservation checks; unsafe output keeps original |
| High | Transform prompts could infer unspecified requirements or remove meaningful uncertainty | Final fidelity instruction overrides tone/structure for built-ins; custom commands retain their intended behavior |
| High | Truncated model completions accepted as finished text | Reject incomplete/empty completions in direct client and API; API timeout/cancellation; direct output budget aligned at 4096 tokens |
| Medium | Filler cleanup collapsed paragraph breaks | Preserve line breaks when normalizing whitespace |
| Medium | Snippet dollar syntax interpreted as replacement tokens; recursive expansions | Literal one-pass Unicode-aware matching; longer overlapping triggers win |
| Medium | In-flight dictionary refresh could repopulate a logged-out user's data | Generation/token checks and refresh of the new owner; recovery output cleared on account changes |
| Medium | Editing command shortcut removed the working shortcut before testing replacement | Keep old binding until new binding succeeds; watchdog reclaims requested key later |
| Medium | Older two-command installations could lack Polish | One-time migration adds Polish only if slot 3 is free; respects empty lists and later deletions |
| Medium | Optional local polishing could block for 30 seconds | 2.5-second deadline; original recognized transcript remains available through existing fallback |

The paste policy deliberately changes clipboard behavior: dictation acts like
copying the resulting text. The previous clipboard is no longer automatically
restored after normal dictation. This directly removes the stale-content race.

## Validation

- Desktop: 106 tests passing, including existing audio-tail, streaming-provider,
  transcript-preservation and metering-contract tests plus new injection,
  transform lifecycle, shortcut-rebinding and timeout regression tests.
- Desktop full build: Rust Flowcast release build, TypeScript and assets passed.
- API: 8 tests passing; TypeScript and Next.js production build passed.
- Native paste harness: `node scripts/run-native-paste.mjs` after `npm run build:ts`.
  Tests real native Ctrl+V against plain input, email input, search, multiline,
  rich contenteditable, shadow DOM, iframe, delayed clipboard reader and long text.
  **Not passed:** Windows foreground focus remained in another app; the guarded
  run timed out waiting for the fixture. No Notepad/Gmail/Outlook acceptance is claimed.
- New installer packaging is local only, with `publish: never` in
  `scripts/package-audit.cjs`. It does not deploy the API changes.

Observed installed-build timing baseline on 2026-09-21: 23 summary events,
median 915 ms and nearest-rank p95 1917 ms from stop to input dispatch.
These are pre-change operational logs, not a benchmark of this candidate.
`ok=true` means the native keystroke call completed, **not verified insertion**.
No transcript content was copied into this audit.

## Remaining gaps and release acceptance

1. **Notepad and actual email composer acceptance:** test focused caret and
   selection replacement, multiple paragraphs, held shortcut modifiers,
   repeated dictations, Unicode and recovery in the user's real applications.
   The fixture is useful coverage but cannot replace those checks.
2. **Measured accuracy:** collect consented English recordings with hand-checked
   reference transcripts (short answers, names, amounts, negation, self-correction,
   long pauses and background noise). Compare word error rate, meaning changes,
   zero-edit rate and p50/p95 stop-to-visible-text latency against Wispr Flow on
   identical recordings. No matched corpus or live model evaluation was available.
3. **Semantic limits:** deterministic guards protect specific anchors, not every
   possible meaning change. Names absent from the personal dictionary and
   subtle semantic reversals still require model-quality evaluation. Conservative
   rejection may return the original instead of an email/prompt.
4. **Insertion limits:** no automatic acknowledgement from arbitrary external
   controls. Read-only fields, elevated apps, remote desktops, custom editors and
   focus changes can refuse native input. Recovery remains necessary. There is
   a small unavoidable interval between selection revalidation and native input.
5. **Short utterances:** existing 800 ms capture and 400 ms measured-speech gates
   can discard brief words. Do not lower them without speech/noise fixtures;
   they currently prevent known silence hallucinations. Audit and tune with the
   English reference corpus before claiming single-word accuracy.
6. **Capability gaps:** toggle recording exists; native hold-to-talk, full voice
   command mode and per-app configurable style profiles are not implemented by
   this patch. No mobile, team-dictionary, offline parity or signing claim.
7. **Release:** verify native acceptance, then
   deploy API and publish a signed/versioned desktop release through the normal
   workflow. Neither has happened here.

## Windows shortcuts

Defaults: Ctrl+Shift+Space for dictation; Ctrl+Shift+1 Email;
Ctrl+Shift+2 Prompt Engineer; Ctrl+Shift+3 Polish; Alt+Shift+Z paste last output.
Selected text is transformed; without selected text, a command shortcut starts
spoken composition and the same shortcut stops it. Existing custom assignments
are respected. Conflicts remain visible and are retried.

## Wispr Flow comparison sources

Official sources checked 2026-09-21:

- https://wisprflow.ai/features — dictionary, snippets and application context.
- https://docs.wisprflow.ai/articles/2719941210-how-to-configure-polish-shortcuts-and-custom-prompts — selected-text transforms.
- https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode — hold/locked command sessions and spoken actions.
- https://docs.wisprflow.ai/articles/6478598909-using-flow-with-linux-wsl-and-terminal-applications — terminal insertion and recovery guidance.

These establish feature expectations; they do not establish comparative speed
or accuracy. Firecrawl credentials reported exhausted credits, so research used
the available web search tool and official sources.
