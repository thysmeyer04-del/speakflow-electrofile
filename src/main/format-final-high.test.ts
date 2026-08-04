import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decideFormattedText,
  retractedSpans,
  sanityCheck,
  validateFormattedTranscript,
} from './format-transcript'

const routes = ['server-formatted', 'local-format'] as const
const accepted = { accepted: true } as const
const numberRejected = { accepted: false, reason: 'protected-number-changed' } as const

function assertRoutesRejectNumber(raw: string, formatted: string): void {
  for (const route of routes) {
    assert.deepEqual(decideFormattedText(route, raw, formatted), {
      route,
      accepted: false,
      text: raw,
      reason: 'protected-number-changed',
    })
  }
}

test('reviewer retraction reproduction cannot mask an earlier invoice number', () => {
  const raw = 'invoice 48219 is at location 7 scratch that 8'
  const formatted = 'Invoice is at location 8.'

  assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected)
  assertRoutesRejectNumber(raw, formatted)
})

test('ordinary scratch-that usage without a plausible correction fails closed', () => {
  const raw = 'invoice 48219 scratch that idea continue review'
  const formatted = 'Invoice. Continue review.'

  assert.equal(retractedSpans(raw).length, 0)
  assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected)
  for (const route of routes) {
    const decision = decideFormattedText(route, raw, formatted)
    assert.equal(decision.accepted, false)
    assert.equal(decision.text, raw)
  }
})

test('a later scalar cannot turn ordinary scratch-that speech into a retraction', () => {
  const cases = [
    {
      raw: 'invoice 48219 scratch that idea 7 continue review',
      formatted: 'Invoice idea 7, continue review.',
    },
    {
      raw: 'invoice 48219 scratch that continue idea 7 review',
      formatted: 'Invoice. Continue idea 7 review.',
    },
  ] as const

  for (const { raw, formatted } of cases) {
    assert.deepEqual(retractedSpans(raw), [], `unexpected retraction span for: ${raw}`)
    for (const route of routes) {
      assert.deepEqual(decideFormattedText(route, raw, formatted), {
        route,
        accepted: false,
        text: raw,
        reason: 'protected-number-changed',
      })
    }
  }
})

test('a scalar correction retracts only the immediately replaced scalar', () => {
  const raw = 'invoice 48219 is at location 7 scratch that 8'
  const spans = retractedSpans(raw)

  assert.equal(spans.length, 1)
  assert.equal(raw.slice(spans[0].start, spans[0].end), '7 scratch that')
  assert.deepEqual(
    validateFormattedTranscript(raw, 'Invoice 48,219 is at location 8.'),
    accepted,
  )
})

test('parallel clause correction cannot absorb unrelated protected content before it', () => {
  const raw = 'invoice 48219 send the old review scratch that send the final review'
  const formatted = 'Send the final review.'

  assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected)
  assertRoutesRejectNumber(raw, formatted)
})

test('unambiguous nearby protected-item corrections remain licensed', () => {
  const cases: Array<{ raw: string; formatted: string; dictionary?: string[] }> = [
    { raw: 'meeting at 2, scratch that, 3', formatted: 'Meeting at 3.' },
    { raw: 'set the dose to 3.5 scratch that 4.25', formatted: 'Set the dose to 4.25.' },
    {
      raw: 'email old@example.test scratch that new@example.test',
      formatted: 'Email new@example.test.',
    },
    {
      raw: 'open https://example.test/old scratch that https://example.test/new',
      formatted: 'Open https://example.test/new.',
    },
    { raw: 'ship 24 trays scratch that 36 trays', formatted: 'Ship 36 trays.' },
    {
      raw: "don't send it today scratch that send it today",
      formatted: 'Send it today.',
    },
    {
      raw: 'book the NiaLabs demo scratch that the ZetaWidget demo',
      formatted: 'Book the ZetaWidget demo.',
      dictionary: ['NiaLabs', 'ZetaWidget'],
    },
  ]

  for (const { raw, formatted, dictionary = [] } of cases) {
    assert.deepEqual(
      validateFormattedTranscript(raw, formatted, dictionary),
      accepted,
      `expected an unambiguous correction for: ${raw}`,
    )
    for (const route of routes) {
      assert.deepEqual(decideFormattedText(route, raw, formatted, dictionary), {
        route,
        accepted: true,
        text: formatted,
        reason: null,
      })
    }
  }
})

test('reviewer list reproduction cannot count an invoice number as a list label', () => {
  const raw =
    'step 1 use invoice number 48219 step 2 file it with the supplier and confirm the shipment today'
  const formatted =
    '1. Use invoice\n2. File it with the supplier and confirm the shipment today\n3. Number'

  assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected)
  assertRoutesRejectNumber(raw, formatted)
})

test('coherent step, ordinal, and bare list labels license matching output counters', () => {
  const cases: Array<[string, string]> = [
    [
      'step 1 call the supplier step 2 check the stock step 3 send the order',
      '1. Call the supplier\n2. Check the stock\n3. Send the order',
    ],
    [
      'first call the supplier second check the stock third send the order',
      '1. Call the supplier\n2. Check the stock\n3. Send the order',
    ],
    [
      'one call the supplier two check the stock three send the order',
      '1. Call the supplier\n2. Check the stock\n3. Send the order',
    ],
  ]

  for (const [raw, formatted] of cases) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted), accepted, raw)
  }
})

test('content numbers remain protected inside a valid spoken list', () => {
  const raw = 'step 1 use invoice number 48219 step 2 file it with the supplier'
  const formatted = '1. Use invoice number\n2. File it with the supplier'

  assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected)
})

test('malformed, mixed, and non-sequential spoken labels do not license counters', () => {
  const cases: Array<[string, string]> = [
    [
      'step 1 call the supplier step 3 send the order',
      '1. Call the supplier\n2. Send the order',
    ],
    [
      'step 1 call the supplier number 2 send the order',
      '1. Call the supplier\n2. Send the order',
    ],
    [
      'first call the supplier third send the order',
      '1. Call the supplier\n2. Send the order',
    ],
    [
      'one call the supplier three send the order four archive it',
      '1. Call the supplier\n2. Send the order\n3. Archive it',
    ],
    [
      'step one alpha step three junk step two beta',
      '1. Alpha\n2. Beta',
    ],
    [
      'number one alpha number three junk number two beta',
      '1. Alpha\n2. Beta',
    ],
    // A malformed label after the licensed 1..K prefix is content, not a
    // discardable label — its words must not vanish from the output just
    // because it happened to come after the point where counting broke.
    [
      'step one alpha step two beta step four junk step three gamma',
      '1. Alpha\n2. Beta',
    ],
    [
      'number one alpha number two beta number four junk number three gamma',
      '1. Alpha\n2. Beta',
    ],
    [
      'step one alpha step two beta step four junk',
      '1. Alpha\n2. Beta',
    ],
  ]

  for (const [raw, formatted] of cases) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected, raw)
    assertRoutesFailClosed(raw, formatted)
  }
})

// ── Punctuated retractions may not widen the abandoned clause ──────────────
// Whisper punctuates dictation, so the token before "scratch that" very often
// carries a comma or a full stop. That is the trigger for the clause
// walk-back, which reached back up to six tokens and swallowed whatever it
// found there — an invoice number, an address, a personal-dictionary term the
// speaker never took back. The abandoned clause may only reach as far as the
// nearest earlier protected value.

function assertRoutesFailClosed(raw: string, formatted: string, dictionary: string[] = []): void {
  for (const route of routes) {
    const decision = decideFormattedText(route, raw, formatted, dictionary)
    assert.equal(decision.accepted, false, `route ${route} accepted: ${raw}`)
    assert.equal(decision.text, raw, `route ${route} did not paste the raw transcript: ${raw}`)
  }
}

test('a punctuated retraction never reaches across an earlier protected value', () => {
  const cases: Array<{
    raw: string
    formatted: string
    dictionary?: string[]
    reason: string
    kept: string
  }> = [
    {
      raw: 'invoice 48219 is at location 7, scratch that, 8',
      formatted: 'Invoice is at location 8.',
      reason: 'protected-number-changed',
      kept: '48219',
    },
    {
      raw: 'invoice 48219 is at location 7. scratch that 8',
      formatted: 'Invoice is at location 8.',
      reason: 'protected-number-changed',
      kept: '48219',
    },
    {
      raw: 'send invoice 48219 by 2, scratch that, 3',
      formatted: 'Send by 3.',
      reason: 'protected-number-changed',
      kept: '48219',
    },
    {
      raw: 'the code is 9981 and the count is 24, scratch that, 36',
      formatted: 'The count is 36.',
      reason: 'protected-number-changed',
      kept: '9981',
    },
    {
      raw: 'email alex@example.test at 2, scratch that, 3',
      formatted: 'At 3.',
      reason: 'protected-email-changed',
      kept: 'alex@example.test',
    },
    {
      raw: 'open https://example.test/spec at 2, scratch that, 3',
      formatted: 'At 3.',
      reason: 'protected-url-changed',
      kept: 'https://example.test/spec',
    },
    {
      raw: 'book the NiaLabs demo at 2, scratch that, 3',
      formatted: 'At 3.',
      dictionary: ['NiaLabs'],
      reason: 'protected-dictionary-term-changed',
      kept: 'NiaLabs',
    },
    // Dropping the "not" inverts the instruction — the widened clause must
    // never reach back over a negation the speaker did not retract.
    {
      raw: 'we will not deliver 24, scratch that, 36 trays',
      formatted: 'Deliver 36 trays.',
      reason: 'protected-negation-changed',
      kept: 'not',
    },
  ]

  for (const { raw, formatted, dictionary = [], reason, kept } of cases) {
    for (const span of retractedSpans(raw, dictionary)) {
      assert.ok(
        !raw.slice(span.start, span.end).includes(kept),
        `the retracted span swallowed "${kept}" in: ${raw}`,
      )
    }
    assert.deepEqual(
      validateFormattedTranscript(raw, formatted, dictionary),
      { accepted: false, reason },
      `expected ${reason} for: ${raw}`,
    )
    assertRoutesFailClosed(raw, formatted, dictionary)
  }
})

test('a punctuated retraction still drops the item it replaced', () => {
  assert.deepEqual(validateFormattedTranscript('meeting at 2, scratch that, 3', 'Meeting at 3.'), accepted)
  for (const route of routes) {
    assert.deepEqual(decideFormattedText(route, 'meeting at 2, scratch that, 3', 'Meeting at 3.'), {
      route,
      accepted: true,
      text: 'Meeting at 3.',
      reason: null,
    })
  }
  assert.deepEqual(
    validateFormattedTranscript(
      'invoice 48219 is at location 7, scratch that, 8',
      'Invoice 48,219 is at location 8.',
    ),
    accepted,
  )
  // A sentence boundary still stops the walk-back exactly where it did before.
  const bounded = 'wire 48219 to the bank. call alex at 2, scratch that, 3'
  const spans = retractedSpans(bounded)
  assert.equal(spans.length, 1)
  assert.equal(bounded.slice(spans[0].start, spans[0].end), 'call alex at 2, scratch that')
})

// ── A partial conversion is not a licensed conversion ──────────────────────
// Licensing the first K spoken labels whenever K counters appeared let a
// formatter simply stop early: three spoken items, two numbered lines, and the
// third item's words gone. The cue families ("step three") survive that by
// their digits or by the unselected-phrase check, but ORDINAL ("third") and
// BARE ("three") labels carry neither — nothing downstream noticed the loss.
// Every spoken label must have become a counter, or the conversion is not
// licensed at all.
test('a partial list conversion cannot drop the labels it left behind', () => {
  const cases: Array<[string, string]> = [
    // Ordinal family: "third review the budget" vanished.
    [
      'first finish the report second send the presentation third review the budget',
      '1. Finish the report\n2. Send the presentation',
    ],
    // ... and the same loss dressed up as a merge into the last line.
    [
      'first finish the report second send the presentation third review the budget',
      '1. Finish the report\n2. Send the presentation and review the budget',
    ],
    // Bare family: "three review the budget" vanished.
    [
      'my goals are one finish the report two send the presentation three review the budget',
      'My goals are:\n1. Finish the report\n2. Send the presentation',
    ],
    // Four spoken, two kept.
    [
      'first call the supplier second check the stock third print the labels fourth send the invoice',
      '1. Call the supplier\n2. Check the stock',
    ],
    // Cue family, for parity with the ordinal and bare cases above.
    [
      'step one finish the report step two send the presentation step three review the budget',
      '1. Finish the report\n2. Send the presentation',
    ],
  ]

  for (const [raw, formatted] of cases) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected, raw)
    assertRoutesFailClosed(raw, formatted)
  }
})

// ── A broken count is not a licensed stopping point ───────────────────────
// Parsing stops at the first label that does not continue the count, so
// "first … second … fourth" was read as a tidy TWO-item list. Two spoken
// labels, two output counters, every downstream check satisfied — and the
// speech after the stray "fourth" was simply gone. ORDINAL and BARE labels
// carry no digits and no cue word, so neither the numeric multiset nor the
// unselected-cue-phrase check ever saw the loss. A label candidate LATER than
// the coherent run means the dictation is malformed: the prefix that did
// count may not license deleting whatever followed the break.
test('an unselected malformed cue cannot survive without its following content', () => {
  const raw =
    'step one prepare the quarterly report with all supporting figures step two send the complete presentation to the finance leadership team step four retain confidential appendix'
  const formatted =
    '1. Prepare the quarterly report with all supporting figures\n2. Send the complete presentation to the finance leadership team\nStep four'

  assert.equal(sanityCheck(raw, formatted), true, 'fixture must reach the deterministic guard')
  assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected)
  assertRoutesFailClosed(raw, formatted)

  const retained = `${formatted} retain confidential appendix`
  assert.deepEqual(validateFormattedTranscript(raw, retained), accepted)
  for (const route of routes) {
    assert.deepEqual(decideFormattedText(route, raw, retained), {
      route,
      accepted: true,
      text: retained,
      reason: null,
    })
  }
})

test('a digit-valued unselected cue cannot survive without its following content', () => {
  const raw =
    'step one prepare the quarterly report with all supporting figures step two send the complete presentation to the finance leadership team step 4 retain confidential appendix'
  const formatted =
    '1. Prepare the quarterly report with all supporting figures\n2. Send the complete presentation to the finance leadership team\nStep 4'

  assert.equal(sanityCheck(raw, formatted), true, 'fixture must reach the deterministic guard')
  assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected)
  assertRoutesFailClosed(raw, formatted)

  const retained = `${formatted} retain confidential appendix`
  assert.deepEqual(validateFormattedTranscript(raw, retained), accepted)
  for (const route of routes) {
    assert.deepEqual(decideFormattedText(route, raw, retained), {
      route,
      accepted: true,
      text: retained,
      reason: null,
    })
  }
})

test('an ordinal or bare candidate after the coherent run blocks a prefix-only conversion', () => {
  const cases: Array<[string, string]> = [
    // Ordinal: first, second, then a non-sequential fourth — "fourth retain
    // confidential appendix" vanished.
    [
      'first call the supplier second check the stock fourth retain confidential appendix',
      '1. Call the supplier\n2. Check the stock',
    ],
    // Bare: one, two, three, then a non-sequential five — "five retain
    // confidential appendix" vanished.
    [
      'one call the supplier two check the stock three send the order five retain confidential appendix',
      '1. Call the supplier\n2. Check the stock\n3. Send the order',
    ],
  ]

  for (const [raw, formatted] of cases) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected, raw)
    assertRoutesFailClosed(raw, formatted)
  }
})

test('a complete list conversion is still accepted on both routes', () => {
  const cases: Array<[string, string]> = [
    [
      'first finish the report second send the presentation third review the budget',
      '1. Finish the report\n2. Send the presentation\n3. Review the budget',
    ],
    [
      'my goals are one finish the report two send the presentation three review the budget',
      'My goals are:\n1. Finish the report\n2. Send the presentation\n3. Review the budget',
    ],
    [
      'step one finish the report step two send the presentation step three review the budget',
      '1. Finish the report\n2. Send the presentation\n3. Review the budget',
    ],
    // A completed list may still carry a trailing noun phrase — the stray
    // "number 48219" breaks the count, so it stays content and keeps its digits.
    [
      'number one call the supplier number two check the stock and quote invoice number 48219',
      '1. Call the supplier\n2. Check the stock and quote invoice number 48,219',
    ],
  ]

  for (const [raw, formatted] of cases) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted), accepted, raw)
    for (const route of routes) {
      assert.deepEqual(decideFormattedText(route, raw, formatted), {
        route,
        accepted: true,
        text: formatted,
        reason: null,
      })
    }
  }
})

// ── Both gates must measure the same retraction ────────────────────────────
// decideFormattedText handed the personal dictionary to the deterministic
// guard but not to the statistical one, so the two gates disagreed about how
// far "scratch that" reached. The statistical gate assumed the WIDER clause —
// the one that swallows the dictionary term — which shrank the retained text
// it measures shrinkage against and quietly lowered its own floor.
test('the route sanity gate measures the same retraction span as the guard', () => {
  const raw = 'book the NiaLabs demo at 2, scratch that, 3'
  const dictionary = ['NiaLabs']
  const dropped = 'NiaLabs 3.'

  // The dictionary term stops the walk-back, so "book the NiaLabs" is retained
  // speech — and an output that kept only the term is a content loss.
  assert.equal(sanityCheck(raw, dropped, dictionary), false)
  for (const route of routes) {
    assert.deepEqual(decideFormattedText(route, raw, dropped, dictionary), {
      route,
      accepted: false,
      text: raw,
      reason: 'sanity-check-failed',
    })
  }

  // Tightening only: an output that keeps the retained speech still passes,
  // and the abandoned 2 is still allowed to go.
  const kept = 'Book the NiaLabs demo at 3.'
  assert.equal(sanityCheck(raw, kept, dictionary), true)
  assert.deepEqual(validateFormattedTranscript(raw, kept, dictionary), accepted)
  for (const route of routes) {
    assert.deepEqual(decideFormattedText(route, raw, kept, dictionary), {
      route,
      accepted: true,
      text: kept,
      reason: null,
    })
  }

  // No dictionary supplied = byte-for-byte the previous behaviour.
  assert.equal(sanityCheck(raw, dropped), sanityCheck(raw, dropped, []))
})
