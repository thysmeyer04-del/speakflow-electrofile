import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultPreferences, validatePreferences, applyCorrections, offlineCleanup } from './dictation-preferences'
import { acceleratorKeys } from './hold-to-talk'
import { getDictationReview, saveDictationPreferences, saveDictationReview, rememberCorrection, forgetCorrection, clearDictationReviews } from './dictation-review'
import { decideFormattedText } from './format-transcript'

test('preferences reject unsupported values, missing fields and arbitrary keys', () => {
  assert.deepEqual(validatePreferences(defaultPreferences), defaultPreferences)
  assert.equal(validatePreferences({ ...defaultPreferences, cleanup: 'anything' }), null)
  assert.equal(validatePreferences({ ...defaultPreferences, command: 'run this' }), null)
  assert.equal(validatePreferences({ cleanup: 'clean' }), null)
})
test('learned replacements are literal, Unicode-aware, longest-first and nonrecursive', () => {
  assert.equal(applyCorrections('tice tices TICE café', [{from:'tice',to:'Thys $&'},{from:'Thys',to:'Wrong'},{from:'café',to:'Café'}]), 'Thys $& tices Thys $& Café')
  assert.equal(applyCorrections('acme labs acme', [{from:'acme',to:'A'},{from:'acme labs',to:'B'}]), 'B A')
})
test('offline structure retains factual anchors through the paste guard', () => {
  for (const raw of ['number one send invoice 48219 number two do not call Sarah', 'Hello James new paragraph please send the invoice tomorrow', 'bullet point apples next bullet oranges']) {
    const output = offlineCleanup(raw)
    assert.ok(output.includes('\n'))
    assert.equal(decideFormattedText('local-format', raw, output).accepted, true)
  }
  assert.equal(offlineCleanup('We need one or two boxes'), 'We need one or two boxes')
})
test('hold-to-talk accepts supported chords and rejects ambiguous keys', () => {
  assert.deepEqual(acceleratorKeys('Control+Shift+Space'), [17,16,32])
  assert.deepEqual(acceleratorKeys('F11'), [122])
  assert.equal(acceleratorKeys('Meta+Space'), null)
  assert.equal(acceleratorKeys('F99'), null)
})
test('comparisons and corrections stay owner-scoped; retention controls erase text', () => {
  saveDictationPreferences('alice', { ...defaultPreferences, speed: 'fast' })
  rememberCorrection('alice', 'tice', 'Thys')
  saveDictationReview('alice', {original:'we is ready',output:'We are ready.',app:'Notepad',pasted:true,totalMs:900,formatMs:400,mode:'clean'})
  assert.equal(getDictationReview('bob').reviews.length, 0)
  assert.equal(getDictationReview('bob').corrections.length, 0)
  assert.equal(getDictationReview('alice').reviews.length, 1)
  forgetCorrection('alice','tice')
  assert.equal(getDictationReview('alice').corrections.length, 0)
  saveDictationPreferences('alice', {...defaultPreferences, retainOriginals:false})
  assert.equal(getDictationReview('alice').reviews.length, 0)
  clearDictationReviews('alice')
})

test('short grammar agreement fixes survive without relaxing factual protection', () => {
  assert.equal(decideFormattedText('local-format', 'we is ready', 'We are ready.').accepted, true)
  assert.equal(decideFormattedText('local-format', 'we are not ready', 'We are ready.').accepted, false)
})
