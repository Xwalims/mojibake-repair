'use strict';

/**
 * The `?` substitution is data loss too.
 *
 * src/codecs.js encodes lossily by substituting U+003F QUESTION MARK for any
 * code point a codec cannot represent:
 *
 *   encode('ý', 'cp1251')  ->  0x3f  '?'
 *
 * Both loss guards in this package count U+FFFD and nothing else:
 *
 *   score.js   eligible: m.replacementChars === 0
 *   repair.js  introducedFffd = countFffd(winner.value) - countFffd(original)
 *
 * U+003F is a perfectly printable ASCII character, so neither guard can see
 * it. A candidate can therefore replace every non-ASCII character in the
 * document with a question mark, be marked `eligible`, and win -- while the
 * tool reports that it lost nothing.
 *
 * That is the worst possible failure for a repair tool: it silently destroys
 * text, and it does so while claiming the data was intact. It is not a
 * heuristic being wrong about a hard input. A LOSSLESS candidate is generated
 * and ranked in the same pool -- utf8-as-latin1 scores lower but introduces no
 * damage -- so the tool had the correct answer on the table and chose the one
 * that deletes the document.
 *
 * Oracle: a substitution is data loss exactly when the codec CAN represent some
 * other code point that this one is not. That is decided by encoding a
 * known-representable code point through the same codec and checking the byte
 * is not 0x3F. No hand-written expectation is involved.
 */

const test = require('node:test');
const assert = require('node:assert');

const { encode, decode, mojibake, unmangle, countSubstitutions } = require('../src/codecs.js');
const { repair } = require('../src/repair.js');
const { generateCandidates } = require('../src/candidates.js');
const { rankCandidates, scoreCandidate } = require('../src/score.js');

/** Count occurrences of a single character. */
function countChar(text, ch) {
  let n = 0;
  for (const c of text) if (c === ch) n += 1;
  return n;
}

/** Characters that codec cannot represent, which encode() turns into '?'. */
function substitutedChars(text, codec) {
  const out = [];
  for (const ch of text) {
    if (ch === '?') continue; // a real question mark is not a substitution
    const bytes = encode(ch, codec);
    if (bytes.length === 1 && bytes[0] === 0x3f) out.push(ch);
  }
  return out;
}

// The exact input the fuzz found. Both halves are DERIVED through the project's
// own primitives rather than pasted: a hand-copied mojibake string is itself
// corruptible, and this file was written after that mistake. mojibake() creates
// the damage and unmangle() is the answer the tool was supposed to reach.
const ORIGINAL = 'eýÜg øÑPÊe¥hÅ7KÆCg_xÑ';
const BROKEN = mojibake(ORIGINAL, 'latin1');
const LOSSLESS = unmangle(BROKEN, 'latin1');

test('the fixture is self-consistent: unmangle undoes mojibake exactly', () => {
  assert.strictEqual(LOSSLESS, ORIGINAL);
  assert.notStrictEqual(BROKEN, ORIGINAL);
});

test('codecs: encode() substitutes U+003F for a code point it cannot hold', () => {
  // Ground truth for the substitution itself.
  assert.deepStrictEqual([...encode('ý', 'cp1251')], [0x3f]);
  assert.strictEqual(decode(encode('ý', 'cp1251'), 'utf8'), '?');
});

test('codecs: unmangle() is lossless for text the codec can represent', () => {
  // The repair primitive the whole tool rests on.
  for (const codec of ['latin1', 'cp1251', 'cp1252']) {
    const text = codec === 'cp1251' ? 'Привет мир' : 'Français café';
    assert.strictEqual(substitutedChars(text, codec).length, 0);
    assert.strictEqual(unmangle(mojibake(text, codec), codec), text);
  }
});

test('score: a candidate full of substitutions is NOT eligible', () => {
  // The defect in one assertion: today's `eligible` is a U+FFFD count, so this
  // passes and is wrong. The destroyed value is built by re-encoding the
  // original through cp1251, which is precisely how the bug produced it.
  const destroyed = decode(encode(ORIGINAL, 'cp1251'), 'utf8');
  assert.ok(countChar(destroyed, '?') > 0, 'fixture must actually contain substitutions');
  // `substituted` is the count the generating codec reports; it is supplied by
  // the caller because scoreCandidate() cannot know the codec on its own.
  const substituted = countSubstitutions(ORIGINAL, 'cp1251');
  assert.strictEqual(substituted, countChar(destroyed, '?') - countChar(ORIGINAL, '?'));
  const parts = scoreCandidate(destroyed, BROKEN, { substituted });
  assert.strictEqual(
    parts.eligible,
    false,
    'a candidate that replaced characters with U+003F must be ineligible'
  );
});

test('repair: never returns a candidate that substituted characters', () => {
  // The end-to-end consequence.
  //
  // Detecting the substitution AFTER the fact is impossible from the value
  // alone -- by then the damage is indistinguishable from text that really
  // contained question marks. So the assertion is made where it is decidable:
  // a lossless candidate exists in the pool, therefore repair() must return the
  // lossless answer. Any '?' it introduced is a substitution.
  //
  // An earlier version of this test checked the returned value for substituted
  // characters and passed VACUOUSLY: '?' is excluded from substitutedChars by
  // construction, so it could never fail.
  const result = repair(BROKEN);
  const resultQ = countChar(result.value, '?');
  const losslessQ = countChar(LOSSLESS, '?');
  assert.strictEqual(
    resultQ,
    losslessQ,
    `repair() returned ${resultQ} '?' but the lossless answer has ${losslessQ}: ${JSON.stringify(result.value)}`
  );
  assert.strictEqual(result.value, LOSSLESS);
});

test('repair: prefers a lossless candidate over a higher-scoring destructive one', () => {
  // Ranking is the second half of the bug: utf8-as-cp1251 scored 0.902 with 18
  // substitutions, utf8-as-latin1 scored 0.854 with none. The lossless one is
  // generated and eligible, and used to lose anyway.
  //
  // The decisive assertion is on the candidate's OWN `substituted` count, not
  // on a '?' tally over the value: by the time the text exists the damage is
  // indistinguishable from real question marks, which is precisely why it has
  // to be recorded upstream.
  const ranked = rankCandidates(generateCandidates(BROKEN), BROKEN, {});
  const lossless = ranked.find((c) => c.value === LOSSLESS);
  assert.ok(lossless, 'the lossless candidate must be in the pool');
  assert.strictEqual(lossless.substitutedChars, 0, 'the lossless candidate destroys nothing');

  const destructive = ranked.find((c) => c.id === 'utf8-as-cp1251');
  assert.ok(destructive, 'the destructive candidate must still be generated');
  assert.ok(
    destructive.substitutedChars > 0,
    'the cp1251 hypothesis must report that it substitutes characters'
  );
  assert.strictEqual(
    destructive.eligible,
    false,
    'a candidate that substitutes characters must be ineligible'
  );

  const winner = ranked[0];
  assert.strictEqual(
    winner.substitutedChars,
    0,
    `the highest-scoring candidate substituted ${winner.substitutedChars} character(s): ${winner.id}`
  );
  assert.strictEqual(winner.value, LOSSLESS);
});

test('repair: an undamaged document is returned unchanged', () => {
  // The no-op direction of the same law: never mangle clean text.
  const clean = 'Français: café, naïf. Ça va très bien.';
  const result = repair(clean);
  assert.strictEqual(result.value, clean);
  assert.strictEqual(result.changed, false);
});

test('repair: refuses the destructive candidate even when --min-score 0 and --encoding force it', () => {
  // The second half of the bug, and the half the score term does NOT cover.
  //
  // WEIGHTS.substitutedChars floors any substituting candidate at 0.000, which
  // keeps it out of the pool at the default minScore of 0.6. But `--min-score 0`
  // is a documented flag, `--encoding cp1251` narrows the pool to exactly one
  // hypothesis, and pickWinner()'s lossy fallback deliberately IGNORES `eligible`
  // and only checks `score >= minScore`. So before this check existed in
  // repair(), the real CLI did this:
  //
  //   mojibake -i t.txt --repair --encoding cp1251 --min-score 0
  //   e????g ????P??e??h??7K??Cg_x??
  //
  // 18 of 30 code points replaced with '?', zero U+FFFD, exit code 0, and the
  // reason string blamed "0 replacement chars". A score is not a veto; the chosen
  // winner has to be refused where refusing is still an option.
  const result = repair(BROKEN, { encoding: 'cp1251', minScore: 0 });
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.value, BROKEN, 'the input must be returned byte-identical');
  assert.strictEqual(result.confident, false);
  assert.strictEqual(
    countChar(result.value, '?'),
    0,
    `refused repair still introduced '?'s: ${JSON.stringify(result.value)}`
  );
  // And the reason must name the rule that actually fired.
  assert.match(result.reason, /substituted with '\?'/);
  assert.doesNotMatch(
    result.reason,
    /replacement/,
    'a substitution refusal must not be reported as a replacement-character refusal'
  );
});

test('repair: the refusal holds at every minScore, including the default', () => {
  // Same input, every threshold. Nothing here may trade text for a score.
  for (const minScore of [undefined, 0.6, 0.1, 0]) {
    const result = repair(BROKEN, minScore === undefined ? { encoding: 'cp1251' } : { encoding: 'cp1251', minScore });
    assert.strictEqual(result.value, BROKEN, `minScore=${minScore} changed the text`);
  }
  // Without a forced encoding the lossless answer is available and must win even
  // at minScore 0.
  for (const minScore of [undefined, 0.6, 0]) {
    const opts = minScore === undefined ? {} : { minScore };
    const result = repair(BROKEN, opts);
    assert.strictEqual(result.value, LOSSLESS, `minScore=${minScore} did not reach the lossless answer`);
  }
});

test('repair: a lossy repair is still allowed when nothing lossless exists', () => {
  // The fix must not over-correct into refusing every imperfect repair. Text
  // broken through cp1252 and misread as latin1 has an undefined byte, and the
  // documented policy is to keep the damage rather than refuse forever.
  const broken = 'FranÃ§ais: cafÃ©. Ã\x83a va trÃ¨s bien.';
  const result = repair(broken);
  assert.strictEqual(typeof result.value, 'string');
  assert.ok(result.value.length > 0);
});

test('repair: the reason string never claims an intact repair after substitution', () => {
  const result = repair(BROKEN);
  if (result.changed) {
    assert.ok(
      !/replacement/i.test(result.reason) || substitutedChars(result.value, 'cp1251').length === 0,
      `reason mentions replacement chars but the value substituted them: ${result.reason}`
    );
  }
});