import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldFormat, decideFormattedText } from './format-transcript'

const cases = [
  ['one call James two email Sarah three review the budget', '1. Call James\n2. Email Sarah\n3. Review the budget'],
  ['1 call James 2 email Sarah 3 review the budget', '1. Call James\n2. Email Sarah\n3. Review the budget'],
  ['firstly we need the report secondly we need the invoice', 'Firstly, we need the report. Secondly, we need the invoice.'],
  ['bullet point call James next bullet email Sarah', '- Call James\n- Email Sarah'],
  ['the reports is ready for review today', 'The reports are ready for review today.'],
  ['the delivery is confirmed for tomorrow on a separate note we need to review the website before Friday', 'The delivery is confirmed for tomorrow.\n\nOn a separate note, we need to review the website before Friday.'],
] as const

for (const [raw, expected] of cases) {
  test(`structure survives both paste guards: ${raw}`, () => {
    assert.equal(shouldFormat(raw), true)
    for (const route of ['server-formatted', 'local-format'] as const) {
      const result = decideFormattedText(route, raw, expected, [])
      assert.equal(result.accepted, true, JSON.stringify(result))
      assert.equal(result.text, expected)
    }
  })
}

test('short sentences get grammar processing; tiny fragments stay instant', () => {
  assert.equal(shouldFormat('we are ready'), true)
  assert.equal(shouldFormat('thank you'), false)
  assert.equal(shouldFormat('new paragraph'), true)
})

test('list formatting cannot drop negation or change amounts', () => {
  const raw = 'number one do not send 250 dollars number two call Sarah'
  for (const output of ['1. Send 250 dollars\n2. Call Sarah', '1. Do not send 350 dollars\n2. Call Sarah']) {
    assert.equal(decideFormattedText('server-formatted', raw, output, []).accepted, false)
  }
})
