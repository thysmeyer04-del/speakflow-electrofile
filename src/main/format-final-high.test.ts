import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decideFormattedText,
  retractedSpans,
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
  ]

  for (const [raw, formatted] of cases) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted), numberRejected, raw)
  }
})
