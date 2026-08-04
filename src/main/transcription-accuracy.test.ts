import test from 'node:test'
import assert from 'node:assert/strict'

import {
  stripFillerWords,
  validateFormattedTranscript,
  formatFallbackText,
  decideFormattedText,
  retractedSpans,
  getLastFormatGuardRejection,
} from './format-transcript'
import { buildDictateDictionaryField } from './dictate'
import { whisperPromptForClip } from './transcribe'
import { buildWhisperPrompt } from './user-context'

test('short utterances keep non-empty pronunciation and dictionary prompt context', () => {
  const prompt = buildWhisperPrompt(
    ['ZetaWidget'],
    [{ spelling: 'NiaLabs', aliases: ['near labs'] }],
  )
  assert.match(prompt, /NiaLabs/)
  assert.match(prompt, /ZetaWidget/)
  assert.equal(whisperPromptForClip(250, prompt), prompt)
  assert.equal(whisperPromptForClip(1_499, prompt), prompt)
  assert.equal(whisperPromptForClip(1_500, prompt), prompt)
})

test('empty prompt context still sends the silence-safe single-space prompt', () => {
  const prompt = buildWhisperPrompt([], [])
  assert.equal(prompt, '')
  assert.equal(whisperPromptForClip(100, prompt), ' ')
  assert.equal(whisperPromptForClip(null, prompt), ' ')
})

test('provider prompt and dictate dictionary fields stay capped without cutting words', () => {
  const prompt = buildWhisperPrompt(
    Array.from({ length: 40 }, (_value, index) => `Term${index.toString().padStart(2, '0')}`),
    [],
  )
  assert.ok(prompt.length <= 200)
  assert.ok(prompt.split(', ').length <= 25)
  const routeDictionary = buildDictateDictionaryField(
    Array.from({ length: 40 }, (_value, index) => `RouteTerm${index.toString().padStart(2, '0')}`),
  )
  assert.ok(routeDictionary.length <= 300)
  assert.ok(routeDictionary.split(',').length <= 25)
  assert.doesNotMatch(routeDictionary, /RouteTer$/)
})

test('formatted output may add punctuation and remove fillers without rejection', () => {
  const raw = 'um please email alex tomorrow'
  assert.equal(stripFillerWords(raw), 'Please email alex tomorrow')
  const result = validateFormattedTranscript(raw, 'Please email Alex tomorrow.', [])
  assert.equal(result.accepted, true)
})

test('guard rejects protected number changes and exposes a safe fallback reason', () => {
  const result = validateFormattedTranscript('invoice 48219 is due', 'Invoice 48291 is due.', [])
  assert.deepEqual(result, { accepted: false, reason: 'protected-number-changed' })
  assert.equal(formatFallbackText('invoice 48219 is due', 'Invoice 48291 is due.', []), 'invoice 48219 is due')
})

test('number preservation is bidirectional multiset equality', () => {
  const cases: Array<[string, string]> = [
    ['ship crates today', 'Ship 10 crates today.'],
    ['ship 10 crates today', 'Ship crates today.'],
    ['ship 10 crates today', 'Ship 10 10 crates today.'],
    ['ship 10 crates today', 'Ship 11 crates today.'],
  ]
  for (const [raw, formatted] of cases) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted, []), {
      accepted: false,
      reason: 'protected-number-changed',
    })
  }
})

test('locale decimal punctuation preserves value without permitting coercion', () => {
  assert.deepEqual(validateFormattedTranscript('add 3,5 kilos', 'Add 3.5 kilos.', []), {
    accepted: true,
  })
  assert.deepEqual(validateFormattedTranscript('add 3.5 kilos', 'Add 3,5 kilos.', []), {
    accepted: true,
  })
  for (const formatted of ['Add 35 kilos.', 'Add 4 kilos.']) {
    assert.deepEqual(validateFormattedTranscript('add 3,5 kilos', formatted, []), {
      accepted: false,
      reason: 'protected-number-changed',
    })
  }
})

test('only clear spoken list structure licenses generated line counters', () => {
  assert.deepEqual(
    validateFormattedTranscript(
      'step one call the supplier step two check the stock',
      '1. Call the supplier\n2. Check the stock',
      [],
    ),
    { accepted: true },
  )
  assert.deepEqual(
    validateFormattedTranscript(
      'step 1 call 10 suppliers step 2 check 20 crates',
      '1. Call 10 suppliers\n2. Check 20 crates',
      [],
    ),
    { accepted: true },
  )
  assert.deepEqual(validateFormattedTranscript('call the supplier', '1. Call the supplier', []), {
    accepted: false,
    reason: 'protected-number-changed',
  })
  assert.deepEqual(
    validateFormattedTranscript(
      'step one call the supplier step two check the stock',
      '1. Call the supplier\n99. Check the stock',
      [],
    ),
    { accepted: false, reason: 'protected-number-changed' },
  )
})

test('guard rejects protected email address changes', () => {
  const result = validateFormattedTranscript(
    'send it to alex@example.test today',
    'Send it to alex@sample.test today.',
    [],
  )
  assert.deepEqual(result, { accepted: false, reason: 'protected-email-changed' })
})

test('guard rejects protected URL changes', () => {
  const result = validateFormattedTranscript(
    'open https://example.test/docs now',
    'Open https://example.test/help now.',
    [],
  )
  assert.deepEqual(result, { accepted: false, reason: 'protected-url-changed' })
})

test('guard rejects explicit negation token changes', () => {
  const result = validateFormattedTranscript('do not ship this today', 'Ship this today.', [])
  assert.deepEqual(result, { accepted: false, reason: 'protected-negation-changed' })
})

test('guard rejects supplied dictionary terms present in raw ASR text being changed', () => {
  const result = validateFormattedTranscript(
    'schedule NiaLabs onboarding',
    'Schedule NeoLabs onboarding.',
    ['NiaLabs'],
  )
  assert.deepEqual(result, { accepted: false, reason: 'protected-dictionary-term-changed' })
})

// ── Explicit spoken retractions ────────────────────────────────────────────
// "meeting at 2, scratch that, 3" is a Backtrack correction: the speaker
// abandoned the 2 on purpose. The guard used to treat that dropped 2 as a
// changed invoice number and fall back to the raw text, so the user got
// "meeting at 2, scratch that, 3" pasted instead of "Meeting at 3."

test('an explicit retraction lets the abandoned number go', () => {
  const raw = 'meeting at 2, scratch that, 3'
  const result = validateFormattedTranscript(raw, 'Meeting at 3.', [])
  assert.deepEqual(result, { accepted: true })
  assert.equal(formatFallbackText(raw, 'Meeting at 3.', []), 'Meeting at 3.')
})

test('the retracted span covers only the words just before the retraction phrase', () => {
  const raw = 'wire 48219 to the bank. call alex at 2, scratch that, 3'
  const spans = retractedSpans(raw)
  assert.equal(spans.length, 1)
  // The span starts at "call" — everything before the full stop is a
  // different thought and stays fully protected.
  assert.equal(raw.slice(spans[0].start, spans[0].end), 'call alex at 2, scratch that')
})

test('protected tokens outside the retracted span are still enforced', () => {
  // The 48219 sits before a sentence boundary, so the retraction never
  // licensed dropping it.
  const raw = 'wire 48219 to the bank. call alex at 2, scratch that, 3'
  assert.deepEqual(validateFormattedTranscript(raw, 'Wire to the bank. Call Alex at 3.', []), {
    accepted: false,
    reason: 'protected-number-changed',
  })
  // A number spoken AFTER the correction is not abandoned either.
  const later = 'meeting at 2, scratch that, 3, and invoice 48219 is due'
  assert.deepEqual(
    validateFormattedTranscript(later, 'Meeting at 3, and invoice is due.', []),
    { accepted: false, reason: 'protected-number-changed' },
  )
})

test('correction-shaped wording that is not an explicit retraction still rejects', () => {
  const ambiguous: Array<[string, string]> = [
    // No retraction phrase at all — just a contrast.
    ['the meeting is at 2 not 3', 'The meeting is at 3.'],
    // "no waiting" / "correctional" / "scratch the surface" are ordinary words.
    ['no waiting at 2 we start at 3', 'No waiting, we start at 3.'],
    ['the correctional facility opens at 2 and 3', 'The correctional facility opens at 3.'],
    ['we scratch the surface at 2 and 3', 'We scratch the surface at 3.'],
    // "I mean" is deliberately NOT treated as a retraction — far too common.
    ['send it at 2 i mean 3', 'Send it at 3.'],
  ]
  for (const [raw, formatted] of ambiguous) {
    assert.equal(retractedSpans(raw).length, 0, `"${raw}" should carry no retraction span`)
    assert.deepEqual(
      validateFormattedTranscript(raw, formatted, []),
      { accepted: false, reason: 'protected-number-changed' },
      `"${raw}" must not be treated as a retraction`,
    )
  }
})

test('generic correction language never exempts protected content', () => {
  const cases = [
    {
      raw: 'ship 24 crates actually ship the crates',
      formatted: 'Ship the crates.',
      dictionary: [] as string[],
      reason: 'protected-number-changed',
    },
    {
      raw: 'email alex@example.test correction email the team',
      formatted: 'Email the team.',
      dictionary: [] as string[],
      reason: 'protected-email-changed',
    },
    {
      raw: 'open https://example.test/old i meant open the document',
      formatted: 'Open the document.',
      dictionary: [] as string[],
      reason: 'protected-url-changed',
    },
    {
      raw: 'book the NiaLabs demo correction book the demo',
      formatted: 'Book the demo.',
      dictionary: ['NiaLabs'],
      reason: 'protected-dictionary-term-changed',
    },
    {
      raw: 'do not ship today actually ship today',
      formatted: 'Ship today.',
      dictionary: [] as string[],
      reason: 'protected-negation-changed',
    },
  ] as const
  for (const c of cases) {
    assert.equal(retractedSpans(c.raw).length, 0, `generic phrase masked content in: ${c.raw}`)
    assert.deepEqual(validateFormattedTranscript(c.raw, c.formatted, [...c.dictionary]), {
      accepted: false,
      reason: c.reason,
    })
  }
})

// ── Whisper prompt safety gate ─────────────────────────────────────────────
// Personal context (names, brands, jargon) only goes to the provider once the
// level monitor has established that the clip actually contains speech. A
// missing, broken or zero reading is NOT evidence of speech, so it gets the
// content-free single space.

test('personal prompt context needs an established speech measurement', () => {
  const prompt = buildWhisperPrompt(
    ['ZetaWidget'],
    [{ spelling: 'NiaLabs', aliases: ['near labs'] }],
  )
  assert.ok(prompt.length > 0)
  // Genuine speech, however short, keeps the personal context.
  for (const ms of [1, 2, 250, 900, 1_499, 1_500, 30_000]) {
    assert.equal(whisperPromptForClip(ms, prompt), prompt, `context suppressed at speechMs=${ms}`)
  }
  // No speech, or no usable measurement at all → content-free single space.
  const unavailable: Array<number | null | undefined> = [
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    null,
    undefined,
  ]
  for (const ms of unavailable) {
    assert.equal(whisperPromptForClip(ms, prompt), ' ', `context leaked at speechMs=${String(ms)}`)
  }
  // Defensive: a non-number that slipped past the types is also unavailable.
  assert.equal(whisperPromptForClip('900' as unknown as number, prompt), ' ')
})

// ── Shared route decision ──────────────────────────────────────────────────
// Both formatting routes (server-formatted /dictate and the local format
// pass) must reach the same verdict through the same code, not through two
// look-alike branches in the controller.

test('both formatting routes decide through one shared runtime helper', () => {
  const raw = 'invoice 48219 is due friday'
  const good = 'Invoice 48,219 is due Friday.'
  for (const route of ['server-formatted', 'local-format'] as const) {
    assert.deepEqual(decideFormattedText(route, raw, good, []), {
      route,
      accepted: true,
      text: good,
      reason: null,
    })
    // Preservation failure → raw fallback with the guard's reason code.
    assert.deepEqual(decideFormattedText(route, raw, 'Invoice 48291 is due Friday.', []), {
      route,
      accepted: false,
      text: raw,
      reason: 'protected-number-changed',
    })
    // Statistical failure (the LLM answered instead of reformatting).
    assert.deepEqual(
      decideFormattedText(route, raw, 'The invoice was paid last week by the finance team.', []),
      { route, accepted: false, text: raw, reason: 'sanity-check-failed' },
    )
    // Nothing usable came back.
    for (const empty of ['', '   ', null, undefined]) {
      assert.deepEqual(decideFormattedText(route, raw, empty, []), {
        route,
        accepted: false,
        text: raw,
        reason: 'formatted-empty',
      })
    }
  }
})

test('both routes reject invented, dropped, duplicated, and changed numbers identically', () => {
  const cases: Array<[string, string]> = [
    ['ship crates today', 'Ship 10 crates today.'],
    ['ship 10 crates today', 'Ship crates today.'],
    ['ship 10 crates today', 'Ship 10 10 crates today.'],
    ['ship 10 crates today', 'Ship 11 crates today.'],
  ]
  for (const [raw, formatted] of cases) {
    for (const route of ['server-formatted', 'local-format'] as const) {
      assert.deepEqual(decideFormattedText(route, raw, formatted, []), {
        route,
        accepted: false,
        text: raw,
        reason: 'protected-number-changed',
      })
    }
  }
})

test('the reported retraction clip is accepted end to end, not just by the guard', () => {
  // The exact clip from the field report. It has to survive BOTH gates — the
  // statistical one measures how much text disappeared, and an explicit
  // retraction is an instruction to make text disappear.
  const raw = 'meeting at 2, scratch that, 3'
  for (const route of ['server-formatted', 'local-format'] as const) {
    assert.deepEqual(decideFormattedText(route, raw, 'Meeting at 3.', []), {
      route,
      accepted: true,
      text: 'Meeting at 3.',
      reason: null,
    })
  }
})

test('a retraction does not license dropping the rest of the dictation', () => {
  // Only the abandoned span may go. A formatter that also swallowed the
  // sentence before it is still caught by the statistical gate.
  const raw =
    'send the invoice to the supplier on friday and confirm the delivery, scratch that, on monday'
  for (const route of ['server-formatted', 'local-format'] as const) {
    assert.deepEqual(decideFormattedText(route, raw, 'Confirm on Monday.', []), {
      route,
      accepted: false,
      text: raw,
      reason: 'sanity-check-failed',
    })
  }
})

test('route decisions keep the observable rejection payload privacy-safe', () => {
  const raw = 'wire 48219 to alex@example.test'
  decideFormattedText('server-formatted', raw, 'Wire 48291 to alex@example.test.', [])
  const last = getLastFormatGuardRejection()
  assert.ok(last, 'a rejection should be recorded')
  assert.deepEqual(Object.keys(last).sort(), ['at', 'reason'])
  assert.equal(last.reason, 'protected-number-changed')
  assert.doesNotMatch(JSON.stringify(last), /48219|48291|alex|example/)
})
