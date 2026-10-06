'use strict';

// What a named encoding does and does not override.
//
// WHY THESE TESTS EXIST
// `--encoding cp1252` is documented as "assume the misdecoding was cp1252", and
// it is tempting to conclude that the detector's automatic suspicion score
// should therefore be skipped whenever an encoding is named: the user has
// already made the call. Implementing that was tried and is WRONG, and these
// tests are the reason it is knowable rather than a matter of opinion.
//
// The detector cannot tell "cafÃ©" from "Maß»". Both are a single UTF-8
// lead/continuation pair at ratio 1.0 -- measured, identical, not merely
// similar. So a document that fails the gate for want of a SECOND pair is one
// the detector is explicitly unable to classify, and the two-pair minimum in
// detect.js is what keeps the German out of the repair path. Treating a named
// encoding as permission to bypass the gate mangles it: "Maß»" comes back as
// "Ma߻", confidently, with no data loss for the FFFD/substitution vetoes to
// catch. Relaxing the gate to a single pair admits exactly the same text.
//
// So the invariant is narrower than it looks, and these tests pin both halves:
// a named encoding is obeyed where the detector DID flag the text, and it does
// not license corrupting correct text where the detector did not.

const assert = require('node:assert/strict');
const test = require('node:test');

const { mojibake } = require('../src/codecs.js');
const { repair } = require('../src/repair.js');
const { measure, looksMojibake } = require('../src/detect.js');
const { MUST_NOT_CHANGE } = require('./fixtures.js');

const CODECS = ['latin1', 'cp1251', 'cp1252'];

test('a named encoding is obeyed when the detector already flagged the text', () => {
  const broken = mojibake('привет мир', 'cp1251');
  assert.equal(looksMojibake(broken).broken, true, 'precondition: detection fires');

  const forced = repair(broken, { encoding: 'cp1251' });
  assert.equal(forced.changed, true);
  assert.equal(forced.value, 'привет мир');
  assert.equal(forced.encoding, 'cp1251');
});

test('a named encoding does NOT license mangling correct text', () => {
  // The regression this file was written for. "Maß»" is correct German and is
  // in MUST_NOT_CHANGE for exactly this reason; forcing latin1 once turned it
  // into "Ma߻". If this ever changes again, the override came back.
  const text = 'Maß»';
  const forced = repair(text, { encoding: 'latin1' });
  assert.equal(forced.value, text, `correct German was mangled: ${JSON.stringify(forced.value)}`);
  assert.equal(forced.changed, false);
});

test('the detector cannot separate "cafÃ©" from "Maß»" -- so the gate stays', () => {
  // The measurement that justifies refusing the "a named encoding skips
  // detection" change. If a future detector CAN tell them apart, the override
  // becomes safe and this test should be revisited -- but it must be revisited
  // deliberately, not by widening a flag until a test went away.
  const broken = measure(mojibake('café', 'cp1252'));
  const clean = measure('Maß»');
  assert.equal(broken.utf8Pairs, clean.utf8Pairs, 'pair counts must match to be inseparable');
  assert.equal(broken.utf8PairRatio, clean.utf8PairRatio, 'ratios must match to be inseparable');
  assert.equal(broken.utf8Pairs, 1, 'the ambiguity is specifically about a single pair');
});

test('forcing any encoding on the whole clean corpus changes nothing', () => {
  // The general form of the guarantee: --encoding narrows the hypothesis pool,
  // it does not remove the checks that refuse a bad hypothesis. Every correct
  // text in the corpus, against every codec the tool supports.
  for (const text of MUST_NOT_CHANGE) {
    for (const codec of CODECS) {
      const result = repair(text, { encoding: codec });
      assert.equal(
        result.value,
        text,
        `${JSON.stringify(text.slice(0, 32))} changed under --encoding ${codec}: ${result.reason}`
      );
      assert.equal(result.changed, false, `${codec} reported a repair on correct text`);
    }
  }
});

test('a wrong named encoding loses data and is refused', () => {
  // Forcing cp1252 on cp1251-broken Russian: the cp1251 "quotes" bytes are
  // undefined in cp1252, so the hypothesis substitutes and must be refused
  // rather than silently corrupting the text.
  const broken = mojibake('привет мир', 'cp1251');
  const wrong = repair(broken, { encoding: 'cp1252' });
  assert.equal(wrong.value, broken, 'a lossy hypothesis must be refused');
  assert.equal(wrong.changed, false);
});

test('detectOnly still reports without changing anything under a forced encoding', () => {
  const broken = mojibake('привет мир', 'cp1251');
  const result = repair(broken, { encoding: 'cp1251', detectOnly: true });
  assert.equal(result.changed, false);
  assert.equal(result.value, broken);
  assert.match(result.reason, /detect-only/);
});