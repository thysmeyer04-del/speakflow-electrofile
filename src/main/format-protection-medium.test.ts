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
