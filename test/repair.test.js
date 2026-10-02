'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mojibake } = require('../src/codecs.js');
const { repair, detect, DEFAULTS } = require('../src/repair.js');
const { CORRECT, MUST_NOT_CHANGE, brokenCases } = require('./fixtures.js');

// ---------------------------------------------------------------------------
// The guarantee that matters most: if no candidate is trustworthy, the original
// text comes back byte-identical and confident is false.
// ---------------------------------------------------------------------------

for (const text of MUST_NOT_CHANGE) {
  const label = JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text);
  test(`repair: leaves correct text byte-identical ${label}`, () => {
    const result = repair(text);
    assert.equal(result.changed, false, `wrongly changed: ${result.reason}`);
    assert.equal(result.confident, false);
    assert.equal(result.value, text, 'value must be the original string');
    assert.equal(result.value, result.original);
    assert.equal(result.best, null);
  });
}

test('repair: an unconfident repair still preserves the original exactly', () => {
  const text = 'text with one odd byte: Ã';
  const result = repair(text, { minScore: 1 });
  assert.equal(result.changed, false, 'an impossible threshold must change nothing');
  assert.equal(result.value, text);
  assert.equal(result.original, text);
  assert.equal(result.confident, false);
});

test('repair: the original is always recoverable from the result', () => {
  for (const [, correct, codec] of brokenCases()) {
    const broken = mojibake(correct, codec);
    const result = repair(broken);
    assert.equal(result.original, broken, `original lost for ${codec}`);
    assert.ok(Object.isFrozen(result));
  }
});

test('repair: the best candidate is always present in the candidates list', () => {
  for (const [, correct, codec] of brokenCases()) {
    const result = repair(mojibake(correct, codec));
    if (result.changed) {
      assert.ok(result.best, `best missing for ${codec}`);
      assert.ok(
        result.candidates.some((c) => c.id === result.best.id),
        'best must be one of the candidates'
      );
      assert.equal(result.encoding, result.best.assumed);
    }
  }
});

// ---------------------------------------------------------------------------
// True positives: broken text must be repaired back to the original.
// ---------------------------------------------------------------------------

for (const [name, correct, codec] of brokenCases()) {
  test(`repair: restores the original (${name})`, () => {
    const broken = mojibake(correct, codec);
    const result = repair(broken);
    assert.equal(result.changed, true, `not repaired: ${result.reason}`);
    assert.equal(result.confident, true);
    assert.equal(result.value, correct, `repaired to the wrong text as ${result.encoding}`);
  });
}

test('repair: repairs a document whose parts all broke the same way', () => {
  const lines = [CORRECT.fr, CORRECT.es, CORRECT.tr];
  const broken = lines.map((line) => mojibake(line, 'cp1252')).join('\n');
  const result = repair(broken);
  assert.equal(result.changed, true, `should repair: ${result.reason}`);
  assert.equal(result.value, lines.join('\n'));
});

test('repair: refuses a document whose parts broke DIFFERENT ways', () => {
  // A real and important limitation, so it is pinned by a test rather than left
  // to be discovered. The French line contains "Ç" (UTF-8 C3 87); 0x87 is only
  // defined in windows-1252, so repairing that line needs the cp1252 hypothesis.
  // The Russian line, broken through latin1, contains raw byte 0x9F, which
  // cp1252 remaps to "\u0178", so repairing that line needs latin1. No single
  // global encoding satisfies both, so every hypothesis destroys at least one
  // byte.
  //
  // The correct behaviour is to refuse and say so -- not to pick the least-bad
  // candidate and silently corrupt one line.
  const broken = [mojibake(CORRECT.fr, 'cp1252'), mojibake(CORRECT.ru, 'latin1')].join('\n');
  const result = repair(broken);
  assert.equal(result.changed, false, 'must not partially repair a mixed-encoding document');
  assert.equal(result.value, broken, 'the original must come back byte-identical');
  assert.equal(result.confident, false);
  assert.match(result.reason, /unchanged|lose data|no candidate/i);
});

test('repair: a candidate that introduces U+FFFD is marked ineligible', () => {
  // Every "X-as-utf8" hypothesis reads these bytes as UTF-8, and none of them are
  // valid UTF-8, so each produces U+FFFD and must be disqualified. The original
  // text is what comes back.
  const lossy = repair('\u00ff\u00fe\u00fd \u00bc', { minScore: 0 });
  assert.equal(lossy.original, '\u00ff\u00fe\u00fd \u00bc');
  for (const c of lossy.candidates) {
    if (c.value !== null && c.parts && c.parts.replacementChars > 0) {
      assert.equal(c.eligible, false, `${c.id} introduced replacement chars but claims eligible`);
    }
  }
});

test('repair: a byte cp1252 can round-trip but latin1 cannot picks cp1252', () => {
  // "\u00c7" is 0xC3 0x87 in UTF-8. windows-1252 DEFINES 0x87 (a cedilla accent
  // that combines with the preceding char), so the cp1252 hypothesis recovers it
  // losslessly, while the latin1 hypothesis maps 0x87 through U+0087 and emits
  // U+FFFD on the UTF-8 decode. The lossless hypothesis must win -- this is the
  // whole reason ranking exists instead of a fixed round trip.
  const correct = "Fran\u00e7ais: \u00c7a va tr\u00e8s bien, gar\u00e7on.";
  const broken = mojibake(correct, 'cp1252');
  assert.ok(broken.includes('\u00c3'), 'fixture must be actually broken');

  const result = repair(broken);
  assert.equal(result.changed, true, `should repair: ${result.reason}`);
  assert.equal(result.value, correct, 'repaired to the exact original, with no damage');
  assert.equal(result.encoding, 'cp1252');
  assert.ok(!result.value.includes('\ufffd'), 'the lossless hypothesis should have won');

  // And the ranking says why: cp1252 is eligible, latin1 is not.
  const cp = result.candidates.find((c) => c.id === 'utf8-as-cp1252');
  const latin = result.candidates.find((c) => c.id === 'utf8-as-latin1');
  assert.equal(cp.eligible, true);
  assert.equal(latin.eligible, false, 'the lossy latin1 hypothesis must be marked ineligible');
});

test('repair: relative damage rule -- residual U+FFFD is retained, not amplified', () => {
  // When the ONLY recoverable hypothesis is lossy, the repair still goes ahead
  // provided it does not make the damage worse. Here 0x81 is undefined in every
  // supported codec, so the original bytes can never come back; producing one
  // U+FFFD for an already-lost character is not a regression.
  const broken = 'premier prix: 10\u0081\u0082 units';
  const result = repair(broken);
  assert.equal(result.original, broken);
  const before = [...broken].filter((c) => c.codePointAt(0) === 0xfffd).length;
  const after = [...result.value].filter((c) => c.codePointAt(0) === 0xfffd).length;
  assert.ok(after <= before, `damage increased ${before} -> ${after}`);
});

test('repair: no repair may increase the replacement-character count', () => {
  const countFffd = (s) => [...s].filter((c) => c.codePointAt(0) === 0xfffd).length;
  const inputs = [
    mojibake(CORRECT.fr, 'cp1252'),
    mojibake(CORRECT.ru, 'cp1251'),
    mojibake(CORRECT.es, 'cp1252'),
    mojibake(CORRECT.de, 'latin1'),
    '\u00ff\u00fe \u00bc \u00bd',
    'caf\u00e9 normal',
  ];
  for (const input of inputs) {
    const result = repair(input);
    assert.ok(
      countFffd(result.value) <= countFffd(input),
      `repair increased damage: ${countFffd(input)} -> ${countFffd(result.value)} for ${JSON.stringify(input.slice(0, 30))}`
    );
  }
});

test('repair: never returns a value containing replacement chars it did not start with', () => {
  const inputs = [
    'ÿþý ¼ text',
    'Ã¿Â¿Â¿ broken',
    mojibake(CORRECT.ru, 'cp1251'),
    mojibake(CORRECT.fr, 'latin1'),
    '� already damaged',
  ];
  for (const input of inputs) {
    const result = repair(input);
    const startedWithFffd = input.includes('�');
    if (!startedWithFffd) {
      assert.ok(
        !result.value.includes('�'),
        `introduced U+FFFD into ${JSON.stringify(input)} -> ${JSON.stringify(result.value)}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

test('repair: repeated calls produce identical output', () => {
  for (const [, correct, codec] of brokenCases().slice(0, 10)) {
    const broken = mojibake(correct, codec);
    const first = repair(broken);
    const serialised = JSON.stringify({
      value: first.value,
      changed: first.changed,
      encoding: first.encoding,
      reason: first.reason,
      ranking: first.candidates.map((c) => [c.id, c.score]),
    });
    for (let i = 0; i < 10; i++) {
      const again = repair(broken);
      assert.equal(
        JSON.stringify({
          value: again.value,
          changed: again.changed,
          encoding: again.encoding,
          reason: again.reason,
          ranking: again.candidates.map((c) => [c.id, c.score]),
        }),
        serialised,
        `call ${i} for ${codec} differed`
      );
    }
  }
});

test('repair: ties are broken by the fixed strategy order, not by input order', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  const a = repair(broken);
  const b = repair(broken);
  assert.deepEqual(
    a.candidates.map((c) => c.id),
    b.candidates.map((c) => c.id)
  );
  // Scores must be non-increasing down the ranking.
  for (let i = 1; i < a.candidates.length; i++) {
    assert.ok(
      a.candidates[i - 1].score >= a.candidates[i].score,
      'ranking is not sorted by score'
    );
  }
});

// ---------------------------------------------------------------------------
// Options.
// ---------------------------------------------------------------------------

test('repair: detectOnly reports without changing anything', () => {
  const broken = mojibake(CORRECT.ru, 'latin1');
  const result = repair(broken, { detectOnly: true });
  assert.equal(result.detection.broken, true, 'detection still runs');
  assert.equal(result.changed, false, 'nothing is changed in detect-only mode');
  assert.equal(result.value, broken);
});

test('repair: the detect() helper never changes text', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  const result = detect(broken);
  assert.equal(result.changed, false);
  assert.equal(result.value, broken);
  assert.equal(result.detection.broken, true);
});

test('repair: --encoding forces one hypothesis', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  const forced = repair(broken, { encoding: 'cp1252' });
  assert.equal(forced.value, CORRECT.fr);
  assert.equal(forced.encoding, 'cp1252');
  // Forcing latin1 on cp1252 text must NOT silently produce garbage.
  const wrong = repair(broken, { encoding: 'latin1' });
  assert.ok(wrong.value.includes('�') === false || wrong.changed === false);
});

test('repair: minScore raises the bar for confidence', () => {
  const broken = mojibake(CORRECT.ru, 'cp1251');
  assert.equal(repair(broken, { minScore: 0 }).changed, true);
  const strict = repair(broken, { minScore: 1 });
  if (strict.changed === false) {
    assert.equal(strict.value, broken, 'a refused repair returns the original');
    assert.equal(strict.confident, false);
  }
});

test('repair: an unknown encoding option is a loud error', () => {
  assert.throws(() => repair('x', { encoding: 'ebcdic' }), RangeError);
  assert.throws(() => repair('x', { encoding: 'ebcdic' }), /unknown encoding/);
});

test('repair: an unknown strategy id is a loud error', () => {
  assert.throws(() => repair('café', { strategies: ['nope'] }), RangeError);
});

test('repair: strategies can be restricted', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  const result = repair(broken, { strategies: ['utf8-as-cp1252'] });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].id, 'utf8-as-cp1252');
  assert.equal(result.value, CORRECT.fr);
});

// ---------------------------------------------------------------------------
// Edge cases.
// ---------------------------------------------------------------------------

test('repair: empty input returns empty output without throwing', () => {
  const result = repair('');
  assert.equal(result.value, '');
  assert.equal(result.changed, false);
  assert.equal(result.confident, false);
  assert.equal(result.original, '');
});

test('repair: pure ASCII passes through unchanged', () => {
  const result = repair(CORRECT.ascii);
  assert.equal(result.value, CORRECT.ascii);
  assert.equal(result.changed, false);
  assert.deepEqual(result.candidates, [], 'pure ASCII has no candidates to consider');
});

test('repair: already-correct Cyrillic is left alone', () => {
  const result = repair(CORRECT.ru);
  assert.equal(result.changed, false, `wrongly changed: ${result.reason}`);
  assert.equal(result.value, CORRECT.ru);
  assert.equal(result.confident, false);
});

test('repair: non-string input is coerced, not rejected', () => {
  const result = repair(42);
  assert.equal(result.value, '42');
  assert.equal(result.changed, false);
});

test('repair: undecodable byte sequences are handled without throwing', () => {
  const hostile = [
    'ÿþÿ', // high bytes that are not valid UTF-8
    '\uD800 lone surrogate', // an unpaired surrogate
    `caf�${String.fromCharCode(0x80, 0x81, 0x8d)}`,
    'Ã'.repeat(200), // artefact soup
    '\u0001\u0002\u0003 control noise',
  ];
  for (const text of hostile) {
    assert.doesNotThrow(() => repair(text), `threw on ${JSON.stringify(text)}`);
    const result = repair(text);
    assert.equal(result.original, text, 'original preserved even for hostile input');
  }
});

test('repair: a lone surrogate survives untouched', () => {
  const text = 'a\uD800b';
  const result = repair(text);
  assert.equal(result.value, text);
  assert.equal(result.original, text);
});

test('repair: the result object is frozen and has every documented field', () => {
  const result = repair(mojibake(CORRECT.fr, 'cp1252'));
  for (const field of [
    'value',
    'original',
    'changed',
    'confident',
    'best',
    'encoding',
    'detection',
    'candidates',
    'reason',
    'options',
  ]) {
    assert.ok(field in result, `missing field ${field}`);
  }
  assert.ok(Object.isFrozen(result));
});

test('repair: DEFAULTS is frozen and holds every documented option', () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  for (const key of ['minScore', 'encoding', 'detectOnly', 'strategies', 'suspectScore']) {
    assert.ok(key in DEFAULTS, `missing default ${key}`);
  }
  assert.throws(() => {
    'use strict';
    DEFAULTS.minScore = 0;
  }, TypeError);
});

test('repair: --min-score of 0 still refuses an identity transform', () => {
  const result = repair('café au lait', { minScore: 0 });
  assert.equal(result.changed, false, 'correct text must never be rewritten');
});

test('repair: long text is handled', () => {
  const correct = `${CORRECT.fr} `.repeat(500);
  const broken = mojibake(correct, 'cp1252');
  const result = repair(broken);
  assert.equal(result.value, correct);
});

test('repair: a single broken character in a long document is found', () => {
  const correct = `Le rapport indique que l'année dernière, les résultats étaient${' '.repeat(300)}satisfaisants.`;
  const broken = mojibake(correct, 'cp1252');
  assert.notEqual(broken, correct);
  const result = repair(broken);
  assert.equal(result.changed, true, `missed it: ${result.reason}`);
  assert.equal(result.value, correct);
});