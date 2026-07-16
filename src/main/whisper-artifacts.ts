// Client-side blocklist for Whisper's classic silence hallucinations.
//
// Whisper was trained on a YouTube-heavy corpus; on silent or near-silent
// input its decoder free-runs into the most common closing lines of that
// corpus — "Thank you for watching", "Please subscribe", subtitle credits —
// in whatever language it was primed toward. The server-side /dictate route
// has its own filter (surfaces as droppedSegments), but the legacy proxy
// path, the dev direct-Groq path and on-device Whisper have none, so
// recording-controller runs every transcript through this list right after
// transcription, on every path.
//
// Deliberately conservative, two safeguards:
//   1. Only fires when the WHOLE transcript equals / starts with a phrase —
//      a real dictation that merely CONTAINS "please subscribe" somewhere in
//      the middle is untouched.
//   2. The caller additionally requires speechMs < ARTIFACT_MAX_SPEECH_MS,
//      so a genuinely spoken "thank you for watching" (which takes well over
//      1.5 s of actual speech) is never eaten.
// Plain "thank you" is intentionally NOT listed: it is a completely
// plausible one-line dictation (replying to a message) and the speech gate
// alone can't distinguish it from the artifact.

/** A blocklist hit only counts as an artifact when the clip carried less
 *  than this much measured speech — above it, trust the transcript. */
export const ARTIFACT_MAX_SPEECH_MS = 1_500

// Phrase prefixes, pre-normalized (lowercase, punctuation stripped, single
// spaces). English plus the Afrikaans/Dutch family — Thys dictates in
// Afrikaans, where Whisper's silent-clip go-tos are the AF/NL YouTube outros.
const PREFIX_ARTIFACTS: readonly string[] = [
  // English
  'thank you for watching',
  'thanks for watching',
  'thank you so much for watching',
  'thank you all for watching',
  'please subscribe',
  'like and subscribe',
  'like comment and subscribe',
  'dont forget to subscribe',
  'do not forget to subscribe',
  'subscribe to my channel',
  'subscribe to the channel',
  'see you in the next video',
  'see you in the next one',
  'see you next time',
  'subtitles by',
  'subtitles provided by',
  'subtitles created by',
  'captions by',
  'closed captions by',
  'transcribed by',
  'transcription by',
  'transcription outsourced by',
  // Afrikaans / Dutch
  'dankie dat jy gekyk het',
  'dankie dat julle gekyk het',
  'dankie vir die kyk',
  'baie dankie vir die kyk',
  'kyk gerus weer',
  'moenie vergeet om te subscribe nie',
  'onderskrifte deur',
  'ondertitels deur',
  'ondertiteling door',
  'ondertiteld door',
  'bedankt voor het kijken',
  'abonneer op die kanaal',
  'abonneer je op',
]

// Full-transcript-only matches: too short/common to allow prefix matching,
// but as an ENTIRE transcript they are the canonical silence artifact.
const EXACT_ARTIFACTS: ReadonlySet<string> = new Set(['you'])

/** Lowercase, strip punctuation (unicode-aware, keeps letters/digits),
 *  collapse whitespace — the canonical form both sides are compared in. */
function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when the transcript IS (or opens with) a known silence artifact.
 *  Callers must combine this with the speechMs condition — this function is
 *  pure text matching and knows nothing about the clip's audio. */
export function isSilenceArtifact(transcript: string): boolean {
  const norm = normalizeTranscript(transcript)
  if (!norm) return false
  if (EXACT_ARTIFACTS.has(norm)) return true
  return PREFIX_ARTIFACTS.some((phrase) => norm.startsWith(phrase))
}
