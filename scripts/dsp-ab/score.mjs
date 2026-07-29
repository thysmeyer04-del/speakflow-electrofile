// Scores the DSP A/B takes: transcribes every recording with the SAME engine
// and settings production uses, then measures error against the known script.
//
//   node scripts/dsp-ab/score.mjs
//
// Two metrics are reported, deliberately:
//   1. Word Error Rate (WER) over the whole script. Absolute WER is inflated
//      by number-formatting differences ("zero eight thirty" vs "08:30")
//      which Whisper renders its own way — but that noise hits BOTH arms
//      identically, so the DIFFERENCE between arms is still a fair signal.
//   2. Proper-noun accuracy — did each hard term survive? This is clean,
//      unambiguous, and is where dictation actually fails in practice.
//
// Transcription is deliberately UNBIASED (prompt = " ", temperature 0): we are
// measuring what the audio itself yields, not what the dictionary rescues.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TAKES = path.join(HERE, 'takes')
const MODEL = 'whisper-large-v3-turbo'

const REFERENCE = `Thys, please confirm the Electrofile installation for Klerksdorp is booked for the twenty-fourth at zero eight thirty.
The revised quote is fourteen thousand five hundred rand, and the extra access point adds one thousand two hundred rand.
I have pushed the Supabase migration and the Deepgram streaming key to Vercel already.
Sarah from Potchefstroom asked whether we can bring the deadline forward to Friday afternoon.
Honestly, I think we should, because the team is available and the weather looks clear.
Please let me know before close of business today so that we can book the technicians and order the remaining hardware without paying the rush fee.`

// The terms that actually break in the field. Matched case-insensitively
// against the raw transcript, so Whisper's capitalisation choices don't count
// against it — only whether it heard the word at all.
const HARD_TERMS = [
  'Thys', 'Electrofile', 'Klerksdorp', 'Supabase', 'Deepgram', 'Vercel',
  'Sarah', 'Potchefstroom',
]

const GROQ_KEY = (() => {
  const env = fs.readFileSync(path.join(HERE, '..', '..', '.env'), 'utf8')
  const m = /^GROQ_API_KEY=(.+)$/m.exec(env)
  if (!m) throw new Error('GROQ_API_KEY not found in Speakflow Electrofile/.env')
  return m[1].trim()
})()

function normalise(text) {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/** Levenshtein over word arrays with a substitution/deletion/insertion split. */
function align(ref, hyp) {
  const n = ref.length, m = hyp.length
  const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = 0; i <= n; i++) d[i][0] = i
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    }
  }
  let i = n, j = m, sub = 0, del = 0, ins = 0
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) sub++
      i--; j--
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { del++; i-- }
    else { ins++; j-- }
  }
  return { sub, del, ins, total: sub + del + ins, refLen: n }
}

async function transcribe(file) {
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file))
  form.append('model', MODEL)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  form.append('prompt', ' ')
  form.append('language', 'en')
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: form,
  })
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 25_000))
    return transcribe(file)
  }
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return ((await res.json()).text ?? '').trim()
}

const refWords = normalise(REFERENCE)

if (!fs.existsSync(TAKES)) {
  console.error('No takes/ directory — run the harness first:\n  npx electron scripts/dsp-ab/main.cjs')
  process.exit(1)
}
const files = fs.readdirSync(TAKES).filter((f) => f.endsWith('.webm')).sort()
if (files.length === 0) {
  console.error('No recordings in takes/ — run the harness first.')
  process.exit(1)
}

const arms = { raw: [], dsp: [] }
console.log(`Reference: ${refWords.length} words. Scoring ${files.length} recording(s) with ${MODEL}.\n`)

for (const file of files) {
  const arm = file.includes('-raw') ? 'raw' : 'dsp'
  const full = path.join(TAKES, file)
  let text
  try {
    text = await transcribe(full)
  } catch (e) {
    console.log(`${file}: FAILED — ${e.message}`)
    continue
  }
  const stats = align(refWords, normalise(text))
  const wer = stats.total / stats.refLen
  const missed = HARD_TERMS.filter((t) => !new RegExp(`\\b${t}\\b`, 'i').test(text))
  arms[arm].push({ file, wer, stats, missed, text })
  console.log(
    `${file.padEnd(22)} WER ${(wer * 100).toFixed(1).padStart(5)}%  ` +
    `(sub ${stats.sub}, del ${stats.del}, ins ${stats.ins})  ` +
    `hard terms ${HARD_TERMS.length - missed.length}/${HARD_TERMS.length}` +
    (missed.length ? `  missed: ${missed.join(', ')}` : ''),
  )
  await new Promise((r) => setTimeout(r, 1500)) // free-tier pacing
}

function summarise(name, list) {
  if (!list.length) return null
  const totalErr = list.reduce((a, r) => a + r.stats.total, 0)
  const totalRef = list.reduce((a, r) => a + r.stats.refLen, 0)
  const wer = totalErr / totalRef
  const hardMissed = list.reduce((a, r) => a + r.missed.length, 0)
  const hardTotal = list.length * HARD_TERMS.length
  console.log(
    `\n${name}: ${list.length} take(s), pooled WER ${(wer * 100).toFixed(2)}% ` +
    `(${totalErr}/${totalRef} words) — sub ${list.reduce((a, r) => a + r.stats.sub, 0)}, ` +
    `del ${list.reduce((a, r) => a + r.stats.del, 0)}, ins ${list.reduce((a, r) => a + r.stats.ins, 0)}; ` +
    `hard terms correct ${hardTotal - hardMissed}/${hardTotal}`,
  )
  return { wer, hardMissed, hardTotal }
}

console.log('\n' + '='.repeat(78))
const rawSum = summarise('RAW (no processing)', arms.raw)
const dspSum = summarise('DSP (processing on)', arms.dsp)

if (rawSum && dspSum) {
  const rel = (dspSum.wer - rawSum.wer) / dspSum.wer
  console.log('\n' + '='.repeat(78))
  console.log(`Turning the microphone processing OFF changes WER by ${(rel * 100).toFixed(1)}% relative.`)
  // Decision rule fixed BEFORE the data was seen (see plan Phase 0).
  if (rel >= 0.15) {
    console.log('VERDICT: ADOPT raw audio — improvement clears the +15% bar.')
  } else if (rel <= -0.05) {
    console.log('VERDICT: REJECT — raw audio is measurably worse. Keep processing on.')
  } else {
    console.log('VERDICT: NO MEASURABLE EFFECT — difference is inside the noise band.')
    console.log('         Keep the current default and look elsewhere for the accuracy win.')
  }
  console.log(`Hard-term misses: raw ${rawSum.hardMissed}, dsp ${dspSum.hardMissed}`)
}
