import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decideFormattedText,
  sanityCheck,
  validateFormattedTranscript,
} from './format-transcript'

const accepted = { accepted: true } as const
const urlRejected = { accepted: false, reason: 'protected-url-changed' } as const
const emailRejected = { accepted: false, reason: 'protected-email-changed' } as const
const negationRejected = { accepted: false, reason: 'protected-negation-changed' } as const
const dictionaryRejected = {
  accepted: false,
  reason: 'protected-dictionary-term-changed',
} as const

test('URL normalization changes only scheme and hostname case', () => {
  assert.deepEqual(
    validateFormattedTranscript(
      'open HTTPS://EXAMPLE.Test/CaseSensitive/Guide?token=AbC#FragMent now',
      'Open https://example.test/CaseSensitive/Guide?token=AbC#FragMent now.',
    ),
    accepted,
  )

  for (const changed of [
    'https://example.test/casesensitive/Guide?token=AbC#FragMent',
    'https://example.test/CaseSensitive/Guide?token=abc#FragMent',
    'https://example.test/CaseSensitive/Guide?token=AbC#fragment',
  ]) {
    assert.deepEqual(
      validateFormattedTranscript(
        'open HTTPS://EXAMPLE.Test/CaseSensitive/Guide?token=AbC#FragMent now',
        `Open ${changed} now.`,
      ),
      urlRejected,
      `${changed} must remain case-sensitive outside the scheme and hostname`,
    )
  }
})

test('URL extraction keeps balanced terminal delimiters that belong to the URL', () => {
  for (const url of [
    'https://example.test/API(Preview)',
    'https://example.test/items[Final]',
    'https://example.test/really!',
  ]) {
    assert.deepEqual(
      validateFormattedTranscript(`open ${url} now`, `Open ${url} now.`),
      accepted,
      `valid terminal URL character was lost for ${url}`,
    )
    assert.deepEqual(
      validateFormattedTranscript(`open ${url} now`, `Open ${url.slice(0, -1)} now.`),
      urlRejected,
      `dropping the valid terminal URL character must reject ${url}`,
    )
  }
})

test('sentence punctuation and wrappers around URLs do not become URL content', () => {
  assert.deepEqual(
    validateFormattedTranscript(
      'read (https://example.test/Guide) today',
      'Read (https://example.test/Guide) today.',
    ),
    accepted,
  )
  assert.deepEqual(
    validateFormattedTranscript(
      'read https://example.test/Guide today',
      'Read https://example.test/Guide! Today.',
    ),
    accepted,
  )
  assert.deepEqual(
    validateFormattedTranscript(
      'read [https://example.test/Guide] today',
      'Read [https://example.test/Guide]. Today.',
    ),
    accepted,
  )
})

test('URL protection rejects invented and dropped URLs with exact multiset equality', () => {
  assert.deepEqual(
    validateFormattedTranscript(
      'open https://example.test/A once',
      'Open https://example.test/A and https://example.test/B once.',
    ),
    urlRejected,
  )
  assert.deepEqual(
    validateFormattedTranscript(
      'open https://example.test/A and https://example.test/A',
      'Open https://example.test/A.',
    ),
    urlRejected,
  )
  assert.deepEqual(
    validateFormattedTranscript(
      'open https://example.test/A once',
      'Open https://example.test/A and https://example.test/A.',
    ),
    urlRejected,
  )
  assert.deepEqual(
    validateFormattedTranscript(
      'open https://example.test/A and https://example.test/B',
      'Open https://example.test/B and https://example.test/A.',
    ),
    accepted,
  )
})

test('canonical dictionary spelling preserves exact-case multiplicity', () => {
  assert.deepEqual(
    validateFormattedTranscript('book NiaLabs today', 'Book nialabs today.', ['NiaLabs']),
    dictionaryRejected,
  )
  assert.deepEqual(
    validateFormattedTranscript(
      'compare NiaLabs with NiaLabs today',
      'Compare NiaLabs today.',
      ['NiaLabs'],
    ),
    dictionaryRejected,
  )
  assert.deepEqual(
    validateFormattedTranscript(
      'compare NiaLabs with NiaLabs today',
      'Compare NiaLabs with nialabs today.',
      ['NiaLabs'],
    ),
    dictionaryRejected,
  )
})

test('case-insensitive ASR dictionary variants may become canonical spelling', () => {
  assert.deepEqual(
    validateFormattedTranscript('book nialabs today', 'Book NiaLabs today.', ['NiaLabs']),
    accepted,
  )
  assert.deepEqual(
    validateFormattedTranscript(
      'compare NiaLabs with nialabs today',
      'Compare NiaLabs with NiaLabs today.',
      ['NiaLabs'],
    ),
    accepted,
  )
})

test('dictionary matching uses Unicode-aware term boundaries', () => {
  // Neither occurrence is a standalone dictionary term: Unicode letters and
  // combining marks on either side keep the text inside the surrounding word.
  assert.deepEqual(
    validateFormattedTranscript(
      'use préÅpost, x́Å, Ǻx, and 猫咪 today',
      'Use prepost, x, x, and dog today.',
      ['Å', '猫'],
    ),
    accepted,
  )
  // Punctuation and emoji are boundaries, so the standalone Unicode term is protected.
  assert.deepEqual(
    validateFormattedTranscript('use 🧪猫—today', 'Use 🧪狗—today.', ['猫']),
    dictionaryRejected,
  )
})

test('valid one-character dictionary terms are protected and canonicalized', () => {
  assert.deepEqual(
    validateFormattedTranscript('use R today', 'Use r today.', ['R']),
    dictionaryRejected,
  )
  assert.deepEqual(
    validateFormattedTranscript('use r today', 'Use R today.', ['R']),
    accepted,
  )
  assert.deepEqual(
    validateFormattedTranscript('use R and R today', 'Use R today.', ['R']),
    dictionaryRejected,
  )
})

test('email protection is exact bidirectional multiset equality', () => {
  const cases: Array<[string, string]> = [
    ['send the update today', 'Send the update to invented@example.test today.'],
    ['send alex@example.test the update', 'Send the update.'],
    [
      'send alex@example.test the update',
      'Send alex@example.test and alex@example.test the update.',
    ],
    ['send alex@example.test the update', 'Send alex@sample.test the update.'],
  ]
  for (const [raw, formatted] of cases) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted), emailRejected)
  }

  assert.deepEqual(
    validateFormattedTranscript(
      'send alex@example.test and alex@example.test the update',
      'Send alex@example.test and alex@example.test the update.',
    ),
    accepted,
  )
})

test('email local parts stay case-sensitive while domains and surrounding punctuation may change', () => {
  assert.deepEqual(
    validateFormattedTranscript(
      'send the update to Alex.Tag@EXAMPLE.Test today',
      'Send the update to (Alex.Tag@example.test), today.',
    ),
    accepted,
  )
  assert.deepEqual(
    validateFormattedTranscript(
      'send the update to Alex.Tag@example.test today',
      'Send the update to alex.tag@example.test today.',
    ),
    emailRejected,
  )
})

test('long shared-route dictations reject invented, duplicated, dropped, and changed emails', () => {
  const raw =
    'please send the completed project update to alex@example.test before friday and confirm that the finance team has reviewed the attached figures for the quarterly planning meeting'
  const cases = [
    'Please send the completed project update to alex@example.test and invented@example.test before Friday, and confirm that the finance team has reviewed the attached figures for the quarterly planning meeting.',
    'Please send the completed project update to alex@example.test and alex@example.test before Friday, and confirm that the finance team has reviewed the attached figures for the quarterly planning meeting.',
    'Please send the completed project update before Friday, and confirm that the finance team has reviewed the attached figures for the quarterly planning meeting.',
    'Please send the completed project update to alex@sample.test before Friday, and confirm that the finance team has reviewed the attached figures for the quarterly planning meeting.',
  ]

  for (const formatted of cases) {
    assert.equal(sanityCheck(raw, formatted), true, 'fixture must reach the deterministic guard')
    for (const route of ['server-formatted', 'local-format'] as const) {
      assert.deepEqual(decideFormattedText(route, raw, formatted), {
        route,
        accepted: false,
        text: raw,
        reason: 'protected-email-changed',
      })
    }
  }
})

test('negation protection rejects invented, dropped, changed, and duplicated unrelated tokens', () => {
  const cases: Array<[string, string]> = [
    ['ship the order today', 'Do not ship the order today.'],
    ['do not ship the order today', 'Ship the order today.'],
    ['never ship the order today', 'Do not ship the order today.'],
    [
      'do not ship the order today and hold the invoice',
      'Do not ship the order today and do not hold the invoice.',
    ],
  ]
  for (const [raw, formatted] of cases) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted), negationRejected)
  }
})

test('shared routes reject invented, dropped, changed, and duplicated negations after sanityCheck', () => {
  const cases: Array<[string, string]> = [
    [
      'please ship the order today and hold the invoice until the finance team confirms the final delivery schedule with the supplier',
      'Please do not ship the order today and hold the invoice until the finance team confirms the final delivery schedule with the supplier.',
    ],
    [
      'please do not ship the order today and hold the invoice until the finance team confirms the final delivery schedule with the supplier',
      'Please ship the order today and hold the invoice until the finance team confirms the final delivery schedule with the supplier.',
    ],
    [
      'please never ship the order today and hold the invoice until the finance team confirms the final delivery schedule with the supplier',
      'Please do not ship the order today and hold the invoice until the finance team confirms the final delivery schedule with the supplier.',
    ],
    [
      'please do not ship the order today and hold the invoice until the finance team confirms the final delivery schedule with the supplier',
      'Please do not ship the order today and do not hold the invoice until the finance team confirms the final delivery schedule with the supplier.',
    ],
  ]
  for (const [raw, formatted] of cases) {
    assert.equal(sanityCheck(raw, formatted), true, 'fixture must reach the deterministic guard')
    for (const route of ['server-formatted', 'local-format'] as const) {
      assert.deepEqual(decideFormattedText(route, raw, formatted), {
        route,
        accepted: false,
        text: raw,
        reason: 'protected-negation-changed',
      })
    }
  }
})

test('scratch that exempts only negations in the immediately abandoned span', () => {
  const corrected =
    'do not ship the old order scratch that ship the new order but never release it without approval'
  const formatted = 'Ship the new order, but never release it without approval.'
  assert.deepEqual(validateFormattedTranscript(corrected, formatted), accepted)

  assert.deepEqual(
    validateFormattedTranscript(corrected, 'Ship the new order, but release it without approval.'),
    negationRejected,
  )

  const unrelated =
    'do not ship the order today and call Alex tomorrow scratch that call Sam tomorrow'
  assert.deepEqual(validateFormattedTranscript(unrelated, 'Call Sam tomorrow.'), negationRejected)
})

test('scratch that exempts only an email in the immediately abandoned span', () => {
  assert.deepEqual(
    validateFormattedTranscript(
      'email old@example.test scratch that email new@example.test',
      'Email new@example.test.',
    ),
    accepted,
  )

  assert.deepEqual(
    validateFormattedTranscript(
      'notify retained@example.test first. email old@example.test scratch that email new@example.test',
      'Notify first. Email new@example.test.',
    ),
    emailRejected,
  )
})

// ── A scalar retraction abandons the scalar, not the clause around it ───────
// "we will not deliver 24, scratch that, 36 trays" abandons the 24 and nothing
// else. The clause the 24 sits in is widened only for the LENGTH accounting in
// sanityCheck; letting that widened clause exempt protected items handed the
// formatter a six-word licence over words the speaker never retracted — enough
// to silently invert "we will not deliver" into "deliver".
test('a scalar retraction never exempts a negation the speaker kept', () => {
  const raw =
    'we will not deliver 24, scratch that, 36 trays tomorrow morning to the warehouse team please confirm'
  const formatted =
    'Deliver 36 trays tomorrow morning to the warehouse team, please confirm.'

  assert.equal(sanityCheck(raw, formatted), true, 'fixture must reach the deterministic guard')
  assert.deepEqual(validateFormattedTranscript(raw, formatted), negationRejected)
  for (const route of ['server-formatted', 'local-format'] as const) {
    assert.deepEqual(decideFormattedText(route, raw, formatted), {
      route,
      accepted: false,
      text: raw,
      reason: 'protected-negation-changed',
    })
  }

  // The negation the speaker stood by survives — that is still accepted, and
  // the retracted 24 is still allowed to go.
  assert.deepEqual(
    validateFormattedTranscript(
      raw,
      'We will not deliver 36 trays tomorrow morning to the warehouse team, please confirm.',
    ),
    accepted,
  )
})

test('a scalar retraction never exempts an email the speaker kept', () => {
  const raw =
    'please email alex@example.test about 24, scratch that, 36 trays tomorrow morning and confirm receipt'
  const formatted = 'About 36 trays tomorrow morning, and confirm receipt.'

  assert.equal(sanityCheck(raw, formatted), true, 'fixture must reach the deterministic guard')
  assert.deepEqual(validateFormattedTranscript(raw, formatted), emailRejected)
  for (const route of ['server-formatted', 'local-format'] as const) {
    assert.deepEqual(decideFormattedText(route, raw, formatted), {
      route,
      accepted: false,
      text: raw,
      reason: 'protected-email-changed',
    })
  }

  assert.deepEqual(
    validateFormattedTranscript(
      raw,
      'Please email alex@example.test about 36 trays tomorrow morning, and confirm receipt.',
    ),
    accepted,
  )
})

// ── The whole address is protected, not just the part after the apostrophe ──
// The extractor's local-part class decides where an address begins. Stopping
// at an apostrophe or ampersand left the leading characters of ordinary real
// addresses (o'brien@, sales&support@) outside the comparison, so rewriting
// them to a different mailbox passed the guard untouched.
test('email local parts with internal atext characters are protected in full', () => {
  const cases: Array<[string, string]> = [
    // The leading "o'" dropped — a different mailbox entirely.
    [
      "email o'brien@example.test the quote before friday and confirm with the finance team today",
      'Email brien@example.test the quote before Friday and confirm with the finance team today.',
    ],
    // The character before the apostrophe respelled.
    [
      "email o'brien@example.test the quote before friday and confirm with the finance team today",
      "Email d'brien@example.test the quote before Friday and confirm with the finance team today.",
    ],
    // Whisper emits the typographic apostrophe.
    [
      'email o’brien@example.test the quote before friday and confirm with the finance team today',
      'Email brien@example.test the quote before Friday and confirm with the finance team today.',
    ],
    [
      'email sales&support@example.test the quote before friday and confirm with the finance team',
      'Email support@example.test the quote before Friday and confirm with the finance team.',
    ],
  ]
  for (const [raw, formatted] of cases) {
    assert.equal(sanityCheck(raw, formatted), true, 'fixture must reach the deterministic guard')
    assert.deepEqual(validateFormattedTranscript(raw, formatted), emailRejected)
    for (const route of ['server-formatted', 'local-format'] as const) {
      assert.deepEqual(decideFormattedText(route, raw, formatted), {
        route,
        accepted: false,
        text: raw,
        reason: 'protected-email-changed',
      })
    }
  }
})

test('an unchanged address with internal atext characters is still accepted', () => {
  const raw =
    "email o'brien@example.test the quote before friday and confirm with the finance team today"
  // Untouched, and re-punctuated around — both are legitimate formatting.
  for (const formatted of [
    "Email o'brien@example.test the quote before Friday and confirm with the finance team today.",
    "Email o'brien@example.test, the quote before Friday, and confirm with the finance team today.",
  ]) {
    assert.deepEqual(validateFormattedTranscript(raw, formatted), accepted)
  }

  // A wrapper the formatter added around a plain address is surrounding
  // punctuation, not part of the local part.
  const plain = 'email alex@example.test the quote before friday and confirm with the finance team'
  for (const formatted of [
    'Email <alex@example.test> the quote before Friday and confirm with the finance team.',
    "Email 'alex@example.test' the quote before Friday and confirm with the finance team.",
  ]) {
    assert.deepEqual(validateFormattedTranscript(plain, formatted), accepted)
  }
})

// ── Consecutive atext specials are one local part, not a boundary ──────────
// Accepting only a SINGLE special between two plain runs made the extractor
// stop at the second character of "foo!#$bar@", so the address it compared was
// the "bar@example.test" tail. Rewriting the mailbox to exactly that tail then
// looked like an unchanged address. RFC 5322 puts no limit on how many atext
// specials sit next to each other.
test('email local parts with consecutive atext specials are protected in full', () => {
  const cases: Array<[string, string]> = [
    // The whole "foo!#$" head dropped — a different mailbox.
    [
      'email foo!#$bar@example.test the quote before friday and confirm with the finance team',
      'Email bar@example.test the quote before Friday and confirm with the finance team.',
    ],
    // A special inside the run respelled.
    [
      'email foo!#$bar@example.test the quote before friday and confirm with the finance team',
      'Email foo!#~bar@example.test the quote before Friday and confirm with the finance team.',
    ],
    // Two specials in a row at the front of the run.
    [
      'email a&&b@example.test the quote before friday and confirm with the finance team today',
      'Email b@example.test the quote before Friday and confirm with the finance team today.',
    ],
    // A typographic apostrophe next to a straight one.
    [
      'email o’#brien@example.test the quote before friday and confirm with the finance team',
      'Email brien@example.test the quote before Friday and confirm with the finance team.',
    ],
  ]
  for (const [raw, formatted] of cases) {
    assert.equal(sanityCheck(raw, formatted), true, `fixture must reach the guard: ${raw}`)
    assert.deepEqual(validateFormattedTranscript(raw, formatted), emailRejected, raw)
    for (const route of ['server-formatted', 'local-format'] as const) {
      assert.deepEqual(decideFormattedText(route, raw, formatted), {
        route,
        accepted: false,
        text: raw,
        reason: 'protected-email-changed',
      })
    }
  }
})

test('a local part with consecutive specials keeps its exact case, the domain does not', () => {
  const raw =
    'email Foo!#$Bar@Example.TEST the quote before friday and confirm with the finance team'

  // Domain case is DNS-insensitive, so normalizing it is a legitimate reformat.
  assert.deepEqual(
    validateFormattedTranscript(
      raw,
      'Email Foo!#$Bar@example.test the quote before Friday and confirm with the finance team.',
    ),
    accepted,
  )

  // The local part is not. Re-casing any part of it can change the mailbox,
  // including the characters the old extractor never captured.
  for (const changed of ['foo!#$Bar', 'Foo!#$bar', 'FOO!#$BAR']) {
    const formatted = `Email ${changed}@Example.TEST the quote before Friday and confirm with the finance team.`
    assert.deepEqual(validateFormattedTranscript(raw, formatted), emailRejected, changed)
    for (const route of ['server-formatted', 'local-format'] as const) {
      assert.deepEqual(decideFormattedText(route, raw, formatted), {
        route,
        accepted: false,
        text: raw,
        reason: 'protected-email-changed',
      })
    }
  }
})

// ── One email definition, or the retraction walk-back steps over an address ─
// The clause walk-back stops at the nearest earlier protected value, and it
// asks correctedScalar() what counts as one. correctedScalar() carried its own
// narrower email pattern, so an address with an apostrophe or ampersand in the
// local part was invisible to it: a numeric "scratch that" three words later
// widened its abandoned clause straight back over the address, and the guard
// then had nothing to enforce.
test('a numeric retraction never swallows an address with atext specials', () => {
  const cases: Array<[string, string]> = [
    ["email o'brien@example.test at 2, scratch that, 3", "o'brien@example.test"],
    ['email o’brien@example.test at 2, scratch that, 3', 'o’brien@example.test'],
    ['email sales&support@example.test at 2, scratch that, 3', 'sales&support@example.test'],
    ['email foo!#$bar@example.test at 2, scratch that, 3', 'foo!#$bar@example.test'],
    ['email foo/bar@example.test at 2, scratch that, 3', 'foo/bar@example.test'],
    ['email foo/!bar@example.test at 2, scratch that, 3', 'foo/!bar@example.test'],
  ]
  for (const [raw, address] of cases) {
    const formatted = 'At 3.'
    assert.deepEqual(validateFormattedTranscript(raw, formatted), emailRejected, raw)
    for (const route of ['server-formatted', 'local-format'] as const) {
      const decision = decideFormattedText(route, raw, formatted)
      assert.equal(decision.accepted, false, `route ${route} accepted: ${raw}`)
      assert.equal(decision.text, raw, `route ${route} did not paste the raw: ${raw}`)
    }

    // The retraction still does its job: the abandoned 2 goes, the address stays.
    assert.deepEqual(
      validateFormattedTranscript(raw, `Email ${address} at 3.`),
      accepted,
      raw,
    )
  }
})
