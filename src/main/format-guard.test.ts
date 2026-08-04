// Synthetic fixture sweep for the deterministic formatter-preservation guard,
// plus the route-parity check that both formatting routes actually run it.
//
// transcription-accuracy.test.ts pins the headline contract; this file is the
// breadth pass — the cases that decide whether the guard is usable in
// production rather than merely correct on the happy path. A guard that
// rejects legitimate formatting is worse than no guard: every false rejection
// silently downgrades a user's dictation to unpunctuated raw text.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  validateFormattedTranscript,
  formatFallbackText,
  getLastFormatGuardRejection,
  decideFormattedText,
  type FormatGuardReason,
  type FormatRejectionReason,
} from './format-transcript'
import { buildDictateDictionaryField } from './dictate'
import { whisperPromptForClip } from './transcribe'
import { buildWhisperPrompt } from './user-context'

// ── Fixtures the guard MUST accept ─────────────────────────────────────────
// Every one of these is something a well-behaved formatter legitimately does.
const ACCEPTED: Array<{ name: string; raw: string; formatted: string; dictionary?: string[] }> = [
  {
    name: 'adds punctuation and sentence capitalization',
    raw: 'the delivery arrives monday we should be ready',
    formatted: 'The delivery arrives Monday. We should be ready.',
  },
  {
    name: 'removes vocal fillers',
    raw: 'um so uh the invoice is ready',
    formatted: 'So the invoice is ready.',
  },
  {
    name: 'converts spoken counters into a numbered list (adds 1. 2. 3.)',
    raw: 'step one call the supplier step two check the stock step three send the order',
    formatted: '1. Call the supplier\n2. Check the stock\n3. Send the order',
  },
  {
    name: 'expands a negative contraction',
    raw: "we don't have stock",
    formatted: 'We do not have stock.',
  },
  {
    name: 'contracts a negative',
    raw: 'we do not have stock',
    formatted: "We don't have stock.",
  },
  {
    name: 'puts a full stop straight after a URL',
    raw: 'the spec is at https://example.test/docs',
    formatted: 'The spec is at https://example.test/docs.',
  },
  {
    name: 'adds a thousands separator to a number',
    raw: 'the total is 48219 rand',
    formatted: 'The total is 48,219 rand.',
  },
  {
    name: 'keeps a decimal number intact',
    raw: 'add 3.5 kilos of flour',
    formatted: 'Add 3.5 kilos of flour.',
  },
  {
    name: 'keeps both of two identical numbers',
    raw: 'order 12 crates and 12 trays',
    formatted: 'Order 12 crates and 12 trays.',
  },
  {
    name: 'preserves a dictionary term verbatim',
    raw: 'book the NiaLabs demo',
    formatted: 'Book the NiaLabs demo.',
    dictionary: ['NiaLabs', 'ZetaWidget'],
  },
  {
    name: 'ignores dictionary terms the ASR never produced',
    raw: 'book the demo for friday',
    formatted: 'Book the demo for Friday.',
    dictionary: ['NiaLabs', 'ZetaWidget'],
  },
  {
    name: 'stands down on an explicit retraction that drops a negation',
    raw: "don't send it today scratch that send it today",
    formatted: 'Send it today.',
  },
  {
    name: 'drops the number the speaker explicitly retracted',
    raw: 'meeting at 2, scratch that, 3',
    formatted: 'Meeting at 3.',
  },

  {
    name: 'drops a retracted dictionary term',
    raw: 'book the NiaLabs demo scratch that the ZetaWidget demo',
    formatted: 'Book the ZetaWidget demo.',
    dictionary: ['NiaLabs', 'ZetaWidget'],
  },
  {
    name: 'keeps a number spoken before the retracted clause',
    raw: 'invoice 48219 is due. call alex at 2, scratch that, 3',
    formatted: 'Invoice 48,219 is due.\n\nCall Alex at 3.',
  },
  {
    name: 'keeps an email address unchanged while repunctuating around it',
    raw: 'invoice alex@example.test by friday',
    formatted: 'Invoice alex@example.test by Friday.',
  },
  {
    name: 'breaks a long dictation into paragraphs',
    raw: 'we shipped the order this morning on a separate note the supplier raised prices',
    formatted:
      'We shipped the order this morning.\n\nOn a separate note, the supplier raised prices.',
  },
]

// ── Fixtures the guard MUST reject, with the exact reason code ─────────────
const REJECTED: Array<{
  name: string
  raw: string
  formatted: string
  dictionary?: string[]
  reason: FormatGuardReason
}> = [
  {
    name: 'a digit inside an invoice number changed',
    raw: 'invoice 48219 is due',
    formatted: 'Invoice 48291 is due.',
    reason: 'protected-number-changed',
  },
  {
    name: 'a number dropped entirely',
    raw: 'deliver 24 trays on tuesday',
    formatted: 'Deliver trays on Tuesday.',
    reason: 'protected-number-changed',
  },
  {
    name: 'one of two repeated numbers dropped',
    raw: 'order 12 crates and 12 trays',
    formatted: 'Order 12 crates and trays.',
    reason: 'protected-number-changed',
  },
  {
    name: 'a decimal quietly rounded',
    raw: 'add 3.5 kilos of flour',
    formatted: 'Add 4 kilos of flour.',
    reason: 'protected-number-changed',
  },
  {
    name: 'an email domain swapped',
    raw: 'send it to alex@example.test today',
    formatted: 'Send it to alex@sample.test today.',
    reason: 'protected-email-changed',
  },
  {
    name: 'an email dropped',
    raw: 'send it to alex@example.test today',
    formatted: 'Send it today.',
    reason: 'protected-email-changed',
  },
  {
    name: 'a URL path rewritten',
    raw: 'open https://example.test/docs now',
    formatted: 'Open https://example.test/help now.',
    reason: 'protected-url-changed',
  },
  {
    name: 'a www URL dropped',
    raw: 'the details are on www.example.test/pricing',
    formatted: 'The details are on the website.',
    reason: 'protected-url-changed',
  },
  {
    name: 'an explicit negation removed',
    raw: 'do not ship this today',
    formatted: 'Ship this today.',
    reason: 'protected-negation-changed',
  },
  {
    name: 'a negation invented',
    raw: 'ship this today',
    formatted: 'Do not ship this today.',
    reason: 'protected-negation-changed',
  },
  {
    name: 'a "never" softened away',
    raw: 'we never approved that price',
    formatted: 'We approved that price.',
    reason: 'protected-negation-changed',
  },
  {
    name: 'a "without" dropped',
    raw: 'deliver without the packaging',
    formatted: 'Deliver the packaging.',
    reason: 'protected-negation-changed',
  },
  {
    name: 'a supplied dictionary term respelled',
    raw: 'schedule NiaLabs onboarding',
    formatted: 'Schedule NeoLabs onboarding.',
    dictionary: ['NiaLabs'],
    reason: 'protected-dictionary-term-changed',
  },
  {
    name: 'a supplied dictionary term dropped',
    raw: 'schedule the ZetaWidget review',
    formatted: 'Schedule the review.',
    dictionary: ['NiaLabs', 'ZetaWidget'],
    reason: 'protected-dictionary-term-changed',
  },
  {
    name: 'formatter returned nothing usable',
    raw: 'invoice 48219 is due',
    formatted: '   ',
    reason: 'formatted-empty',
  },
  // ── Adversarial: a retraction never becomes a licence to drop everything ──
  {
    name: 'a number from a different sentence dropped alongside a real retraction',
    raw: 'invoice 48219 is due. call alex at 2, scratch that, 3',
    formatted: 'Invoice is due.\n\nCall Alex at 3.',
    reason: 'protected-number-changed',
  },
  {
    name: 'a number spoken after the retraction dropped',
    raw: 'meeting at 2, scratch that, 3, and invoice 48219 is due',
    formatted: 'Meeting at 3, and invoice is due.',
    reason: 'protected-number-changed',
  },
  {
    name: 'an email from before the retracted clause dropped',
    raw: 'email alex@example.test the quote. send 24 trays, scratch that, 36 trays',
    formatted: 'Email the quote.\n\nSend 36 trays.',
    reason: 'protected-email-changed',
  },
  {
    name: 'a negation outside the retracted span invented',
    raw: 'ship 24 trays, scratch that, 36 trays on friday',
    formatted: 'Do not ship 36 trays on Friday.',
    reason: 'protected-negation-changed',
  },
  {
    name: 'a dictionary term outside the retracted span dropped',
    raw: 'book the NiaLabs demo. send 24 trays, scratch that, 36 trays',
    formatted: 'Book the demo.\n\nSend 36 trays.',
    dictionary: ['NiaLabs'],
    reason: 'protected-dictionary-term-changed',
  },
  {
    name: 'no retraction phrase at all — a dropped number is still a rejection',
    raw: 'the meeting is at 2 not 3',
    formatted: 'The meeting is at 3.',
    reason: 'protected-number-changed',
  },
  {
    name: '"scratch the surface" is not a retraction',
    raw: 'we scratch the surface at 2 and 3',
    formatted: 'We scratch the surface at 3.',
    reason: 'protected-number-changed',
  },
  {
    name: '"no waiting" is not a retraction',
    raw: 'no waiting at 2 we start at 3',
    formatted: 'No waiting, we start at 3.',
    reason: 'protected-number-changed',
  },
  {
    name: '"correctional" is not a retraction',
    raw: 'the correctional facility opens at 2 and 3',
    formatted: 'The correctional facility opens at 3.',
    reason: 'protected-number-changed',
  },
  {
    name: 'run-on speech: a retraction only reaches back a few words',
    raw: 'the invoice number is 48219 and the delivery is on tuesday at 2 scratch that 3',
    formatted: 'The invoice number is and the delivery is on Tuesday at 3.',
    reason: 'protected-number-changed',
  },
]

test(`guard accepts all ${ACCEPTED.length} legitimate formatting fixtures`, () => {
  for (const fixture of ACCEPTED) {
    const result = validateFormattedTranscript(
      fixture.raw,
      fixture.formatted,
      fixture.dictionary ?? [],
    )
    assert.deepEqual(
      result,
      { accepted: true },
      `expected acceptance for "${fixture.name}" but got ${JSON.stringify(result)}`,
    )
    // An accepted verdict must hand back the FORMATTED text, not the raw one.
    assert.equal(
      formatFallbackText(fixture.raw, fixture.formatted, fixture.dictionary ?? []),
      fixture.formatted,
      `accepted fixture "${fixture.name}" should paste the formatted text`,
    )
  }
})

test(`guard rejects all ${REJECTED.length} content-changing fixtures with the right reason`, () => {
  for (const fixture of REJECTED) {
    const result = validateFormattedTranscript(
      fixture.raw,
      fixture.formatted,
      fixture.dictionary ?? [],
    )
    assert.deepEqual(
      result,
      { accepted: false, reason: fixture.reason },
      `wrong verdict for "${fixture.name}"`,
    )
    // A rejected verdict must hand back the RAW transcript untouched — the
    // user never loses their dictation to a failed format pass.
    assert.equal(
      formatFallbackText(fixture.raw, fixture.formatted, fixture.dictionary ?? []),
      fixture.raw,
      `rejected fixture "${fixture.name}" should paste the raw transcript`,
    )
  }
})

test('rejection reason is observable and carries no transcript content', () => {
  const raw = 'wire 48219 to alex@example.test'
  formatFallbackText(raw, 'Wire 48291 to alex@example.test.', [])
  const last = getLastFormatGuardRejection()
  assert.ok(last, 'a rejection should be recorded')
  assert.equal(last.reason, 'protected-number-changed')
  assert.equal(typeof last.at, 'number')
  // The observable payload is a fixed code plus a timestamp — nothing that
  // could leak what the user dictated.
  assert.deepEqual(Object.keys(last).sort(), ['at', 'reason'])
  assert.doesNotMatch(last.reason, /48219|48291|alex|example/)
})

test('guard is pure — repeated calls on the same inputs give the same verdict', () => {
  const raw = 'call 0721234567 and email alex@example.test about https://example.test/x'
  const formatted = 'Call 0721234567 and email alex@example.test about https://example.test/x.'
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted, ['NiaLabs']), { accepted: true })
  }
  const bad = 'Call 0721234568 and email alex@example.test about https://example.test/x.'
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(validateFormattedTranscript(raw, bad, ['NiaLabs']), {
      accepted: false,
      reason: 'protected-number-changed',
    })
  }
})

// ── Route parity ───────────────────────────────────────────────────────────
// Two formatting routes reach the user: the /dictate server formatter and the
// local Groq formatter. Both must reach the same verdict, or the protection
// silently depends on which route happened to serve the dictation.
//
// This is checked by RUNNING the shared decision helper both routes call —
// the source scan below is only a supplement that keeps the controller wired
// to it.

const ROUTES = ['server-formatted', 'local-format'] as const

test('every route decision is identical on both routes, accepted and rejected', () => {
  const cases: Array<{
    name: string
    raw: string
    formatted: string | null | undefined
    dictionary?: string[]
    accepted: boolean
    reason: FormatRejectionReason | null
  }> = [
    {
      name: 'ordinary repunctuation',
      raw: 'the delivery arrives monday we should be ready',
      formatted: 'The delivery arrives Monday. We should be ready.',
      accepted: true,
      reason: null,
    },
    {
      name: 'explicit retraction',
      raw: 'meeting at 2, scratch that, 3, please confirm with the team today',
      formatted: 'Meeting at 3, please confirm with the team today.',
      accepted: true,
      reason: null,
    },
    {
      name: 'changed invoice number',
      raw: 'invoice 48219 is due friday',
      formatted: 'Invoice 48291 is due Friday.',
      accepted: false,
      reason: 'protected-number-changed',
    },
    {
      name: 'dropped negation',
      raw: 'do not ship this today please hold it for the monday run',
      formatted: 'Ship this today, please hold it for the Monday run.',
      accepted: false,
      reason: 'protected-negation-changed',
    },
    {
      name: 'respelled dictionary term',
      raw: 'schedule the NiaLabs onboarding for friday morning please',
      formatted: 'Schedule the NeoLabs onboarding for Friday morning, please.',
      dictionary: ['NiaLabs'],
      accepted: false,
      reason: 'protected-dictionary-term-changed',
    },
    {
      name: 'the model answered instead of reformatting',
      raw: 'invoice 48219 is due friday',
      formatted: 'The invoice was paid last week by the finance team, nothing is outstanding.',
      accepted: false,
      reason: 'sanity-check-failed',
    },
    {
      name: 'nothing came back',
      raw: 'invoice 48219 is due friday',
      formatted: '   ',
      accepted: false,
      reason: 'formatted-empty',
    },
    {
      name: 'route returned no formatted text at all',
      raw: 'invoice 48219 is due friday',
      formatted: undefined,
      accepted: false,
      reason: 'formatted-empty',
    },
  ]

  for (const c of cases) {
    const decisions = ROUTES.map((route) =>
      decideFormattedText(route, c.raw, c.formatted, c.dictionary ?? []),
    )
    for (const [i, route] of ROUTES.entries()) {
      assert.deepEqual(
        decisions[i],
        {
          route,
          accepted: c.accepted,
          text: c.accepted ? c.formatted : c.raw,
          reason: c.reason,
        },
        `"${c.name}" decided differently on the ${route} route`,
      )
    }
    // Same verdict, same pasted text, same reason — route cannot matter.
    assert.equal(decisions[0].accepted, decisions[1].accepted)
    assert.equal(decisions[0].text, decisions[1].text)
    assert.equal(decisions[0].reason, decisions[1].reason)
  }
})

test('the statistical gate is unchanged for dictations with no retraction', () => {
  // The retraction work only ever relaxes the "how much text disappeared"
  // baseline on clips that actually contain a recognized retraction phrase.
  // An ordinary dictation that lost a third of its content is still refused
  // on both routes.
  const raw = 'we shipped the order this morning and the supplier raised prices on friday'
  for (const route of ROUTES) {
    assert.deepEqual(decideFormattedText(route, raw, 'We shipped the order this morning.', []), {
      route,
      accepted: false,
      text: raw,
      reason: 'sanity-check-failed',
    })
    // And a formatter that padded the dictation out is refused too.
    assert.deepEqual(
      decideFormattedText(
        route,
        raw,
        'We shipped the order this morning and the supplier raised prices on Friday. ' +
          'Please let me know if you would like me to follow up with them about the increase.',
        [],
      ),
      { route, accepted: false, text: raw, reason: 'sanity-check-failed' },
    )
  }
})

test('a rejected route decision never leaks transcript content into the payload', () => {
  for (const route of ROUTES) {
    const raw = 'wire 48219 to alex@example.test before friday please'
    decideFormattedText(route, raw, 'Wire 48291 to alex@example.test before Friday, please.', [])
    const last = getLastFormatGuardRejection()
    assert.ok(last, `${route} rejection should be recorded`)
    assert.deepEqual(Object.keys(last).sort(), ['at', 'reason'])
    assert.equal(last.reason, 'protected-number-changed')
    assert.doesNotMatch(JSON.stringify(last), /48219|48291|alex|example|wire/i)
  }
})

test('the controller wires both formatting routes to the shared decision helper', () => {
  // Supplements the executable checks above: read the COMPILED controller —
  // that is what actually ships — and strip comments first, so a mention in a
  // comment can never stand in for a real call site. TypeScript emits imported
  // calls as `(0, format_transcript_1.decideFormattedText)(...)`, so the call
  // pattern has to tolerate the namespace prefix and the comma-operator
  // parentheses.
  const controller = fs
    .readFileSync(path.join(__dirname, 'recording-controller.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  const callSites = controller.match(/\bdecideFormattedText\b\s*\)?\s*\(/g) ?? []
  assert.equal(
    callSites.length,
    2,
    'expected the shared decision helper on exactly two routes (server-formatted + locally formatted)',
  )
  // Both route names must be the ones the helper knows about.
  assert.match(controller, /'server-formatted'/)
  assert.match(controller, /'local-format'/)
  // The server-formatted route specifically must be one of them.
  assert.match(controller, /serverFormatted[\s\S]{0,400}?decideFormattedText/)
})

// ── Provider payload bounds ────────────────────────────────────────────────
test('provider prompt stays bounded as the dictionary grows', () => {
  const sizes = [0, 1, 5, 25, 40, 200]
  for (const size of sizes) {
    const prompt = buildWhisperPrompt(
      Array.from({ length: size }, (_v, i) => `Term${String(i).padStart(3, '0')}`),
      [],
    )
    assert.ok(prompt.length <= 200, `prompt too long at ${size} words: ${prompt.length}`)
    if (size > 0) assert.ok(prompt.split(', ').length <= 25)
    // No half-word at the tail — the cap must break between terms.
    if (prompt) assert.doesNotMatch(prompt, /Term\d{0,2}$/)

    const field = buildDictateDictionaryField(
      Array.from({ length: size }, (_v, i) => `Route${String(i).padStart(3, '0')}`),
    )
    assert.ok(field.length <= 300, `dictionary field too long at ${size} words: ${field.length}`)
    if (field) {
      assert.ok(field.split(',').length <= 25)
      assert.doesNotMatch(field, /Route\d{0,2}$/)
    }
  }
})

test('pronunciation spellings never age out of the prompt behind dictionary words', () => {
  const prompt = buildWhisperPrompt(
    Array.from({ length: 200 }, (_v, i) => `Term${String(i).padStart(3, '0')}`),
    [{ spelling: 'NiaLabs', aliases: ['near labs'] }],
  )
  assert.match(prompt, /^NiaLabs/)
  // And that prompt survives the short-clip gate on every genuine duration.
  for (const ms of [1, 250, 900, 1_499, 1_500, 30_000]) {
    assert.equal(whisperPromptForClip(ms, prompt), prompt, `prompt suppressed at speechMs=${ms}`)
  }
  // No measured speech — scored silent, or no usable reading at all — falls
  // back to the content-free single space. Personal words are never sent to
  // the provider on the strength of a measurement that does not exist.
  for (const ms of [0, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(whisperPromptForClip(ms, prompt), ' ', `context leaked at speechMs=${String(ms)}`)
  }
})
