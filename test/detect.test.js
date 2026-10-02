'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mojibake } = require('../src/codecs.js');
const {
  analyse,
  looksMojibake,
  measure,
  SIGNAL_WEIGHTS,
  SUSPECT_THRESHOLD,
  THRESHOLDS,
} = require('../src/detect.js');
const { CORRECT, MUST_NOT_CHANGE, brokenCases } = require('./fixtures.js');

// ---------------------------------------------------------------------------
// The false-positive suite: the single most important set of tests in the
// project. Correct Western European text looks suspicious to every naive
// detector, and corrupting it is worse than failing to repair broken text.
// ---------------------------------------------------------------------------

for (const text of MUST_NOT_CHANGE) {
  const label = JSON.stringify(text.length > 44 ? `${text.slice(0, 44)}...` : text);
  test(`detect: does not flag correct text ${label}`, () => {
    const result = looksMojibake(text);
    assert.equal(
      result.broken,
      false,
      `false positive on correct text: signals ${JSON.stringify(result.signals)} score ${result.score}`
    );
    assert.equal(result.score, 0, 'a correct text must score exactly 0, not merely low');
  });
}

test('detect: correct Western European text fires no signals at all', () => {
  const western = [CORRECT.fr, CORRECT.es, CORRECT.pt, CORRECT.tr, CORRECT.de];
  for (const text of western) {
    const { signals } = analyse(text);
    assert.deepEqual(signals, [], `signals fired on ${JSON.stringify(text.slice(0, 30))}`);
  }
});

test('detect: correct Cyrillic text fires no signals', () => {
  const cyrillic = [CORRECT.ru, CORRECT.ru2, CORRECT.uk, CORRECT.bg, CORRECT.mk, CORRECT.sr];
  for (const text of cyrillic) {
    const { signals } = analyse(text);
    assert.deepEqual(signals, [], `signals fired on ${JSON.stringify(text.slice(0, 30))}`);
  }
});

test('detect: non-Latin scripts are never flagged', () => {
  for (const text of [CORRECT.ja, CORRECT.zh, CORRECT.ar, CORRECT.he, CORRECT.el, CORRECT.math]) {
    assert.equal(looksMojibake(text).broken, false, `flagged ${JSON.stringify(text.slice(0, 20))}`);
  }
});

// ---------------------------------------------------------------------------
// The true-positive suite.
// ---------------------------------------------------------------------------

for (const [name, correct, codec] of brokenCases()) {
  test(`detect: flags broken text (${name})`, () => {
    const broken = mojibake(correct, codec);
    assert.notEqual(broken, correct, 'the fixture must actually be broken');
    const result = looksMojibake(broken);
    assert.equal(result.broken, true, `missed broken text: ${result.reason}`);
    assert.ok(result.signals.length > 0, 'a verdict must name the signal that fired');
  });
}

test('detect: latin1-broken Russian is caught by the byte-pair signal', () => {
  const broken = mojibake(CORRECT.ru, 'latin1');
  const { signals } = analyse(broken);
  assert.ok(signals.includes('utf8-pair'), `expected utf8-pair, got ${signals}`);
});

test('detect: cp1251-broken Russian is caught by the cyrillic-extras signal', () => {
  const broken = mojibake(CORRECT.ru, 'cp1251');
  const { signals, metrics } = analyse(broken);
  assert.ok(
    signals.includes('cyrillic-extras'),
    `expected cyrillic-extras, got ${signals} (ratio ${metrics.cyrillicExtrasRatio})`
  );
  // The whole point: this flavour has NO byte-pair structure at all.
  assert.equal(metrics.utf8Pairs, 0, 'cp1251 mojibake must have zero byte pairs');
});

// ---------------------------------------------------------------------------
// Edge cases.
// ---------------------------------------------------------------------------

test('detect: empty string is not broken', () => {
  const result = looksMojibake('');
  assert.equal(result.broken, false);
  assert.equal(result.score, 0);
  assert.match(result.reason, /ASCII|signature/);
});

test('detect: pure ASCII is not broken', () => {
  assert.equal(looksMojibake(CORRECT.ascii).broken, false);
  assert.equal(looksMojibake(CORRECT.en).broken, false);
});

test('detect: whitespace and newlines only is not broken', () => {
  for (const text of ['   ', '\n\n', '\t', ' \n\t ']) {
    assert.equal(looksMojibake(text).broken, false, JSON.stringify(text));
  }
});

test('detect: replacement characters alone are enough to flag text', () => {
  const damaged = `caf� ${'x'.repeat(40)}`;
  const { signals } = analyse(damaged);
  assert.ok(signals.includes('replacement'), `got ${signals}`);
});

test('detect: C1 control characters flag text', () => {
  const damaged = `caf${String.fromCharCode(0x92)} ${'x'.repeat(40)}`;
  const { signals, metrics } = analyse(damaged);
  assert.ok(signals.includes('c1-control'), `got ${signals}`);
  assert.equal(metrics.c1Controls, 1);
});

test('detect: emoji and CJK survive detection untouched', () => {
  assert.equal(looksMojibake('👋🎉🌍 こんにちは 你好 안녕하세요').broken, false);
});

test('detect: score is within [0, 1]', () => {
  const inputs = [...MUST_NOT_CHANGE, ...brokenCases().map(([, c, k]) => mojibake(c, k)), ''];
  for (const text of inputs) {
    const { score } = analyse(text);
    assert.ok(score >= 0 && score <= 1, `score ${score} out of range for ${JSON.stringify(text.slice(0, 30))}`);
  }
});

test('detect: a single signal alone exceeds the suspect threshold', () => {
  // Justified in detect.js: every signal is independently false-positive free at
  // its own threshold, so one firing is sufficient evidence. If this ever fails,
  // either a signal's threshold loosened or its weight dropped.
  for (const [name, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    assert.ok(
      weight >= SUSPECT_THRESHOLD,
      `signal ${name} weighs ${weight}, below the suspect threshold ${SUSPECT_THRESHOLD}`
    );
  }
});

test('detect: detection is deterministic across repeated calls', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  const first = JSON.stringify(analyse(broken));
  for (let i = 0; i < 25; i++) {
    assert.equal(JSON.stringify(analyse(broken)), first, `run ${i} differed`);
  }
});

test('detect: measure() counts are internally consistent', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  const m = measure(broken);
  assert.equal(m.length, [...broken].length);
  assert.ok(m.nonAscii > 0);
  assert.ok(m.utf8Pairs > 0);
  assert.ok(m.utf8PairRatio > 0 && m.utf8PairRatio <= 1);
  // 2 characters per pair, never more than all the non-ASCII characters.
  assert.ok(m.utf8PairRatio <= 1, 'ratio must be <= 1');
});

test('detect: thresholds are exported and frozen', () => {
  assert.ok(Object.isFrozen(THRESHOLDS));
  assert.throws(() => {
    'use strict';
    THRESHOLDS.suspect = 0;
  }, TypeError);
});

test('detect: thresholds can be overridden per call', () => {
  // Pure ASCII carries no artefacts at all, so raising the byte-pair threshold
  // above the maximum achievable ratio can only ever suppress the signal.
  const pure = 'café au lait, très bien';
  assert.equal(analyse(pure, { thresholds: { utf8PairMinRatio: 2 } }).signals.length, 0);
  assert.equal(looksMojibake(pure).signals.length, 0, 'correct text fires nothing to suppress');

  const broken = mojibake(CORRECT.ru, 'latin1');
  assert.equal(looksMojibake(broken).broken, true);

  // Suppressing ONE signal does not necessarily suppress the verdict: this text
  // independently trips c1-control as well. The point is that overrides take
  // effect, not that any single override silences the detector.
  const raised = analyse(broken, { thresholds: { utf8PairMinRatio: 2 } });
  assert.equal(raised.signals.includes('utf8-pair'), false, 'the override was not applied');
  assert.equal(raised.signals.includes('c1-control'), true, 'the independent signal still fires');

  // Suppressing the remaining signal does suppress the verdict.
  const allSuppressed = analyse(broken, {
    thresholds: { utf8PairMinRatio: 2, c1MinRatio: 2 },
  });
  assert.equal(allSuppressed.suspect, false, 'an unreachable threshold must suppress the verdict');
});

test('detect: looksMojibake returns a score and a reason, not a boolean', () => {
  const result = looksMojibake(CORRECT.fr);
  assert.equal(typeof result.broken, 'boolean');
  assert.equal(typeof result.score, 'number');
  assert.equal(typeof result.reason, 'string');
  assert.ok(Array.isArray(result.signals));
  assert.ok(result.reason.length > 0, 'a reason is always present');
});

test('detect: non-string input does not throw', () => {
  for (const input of [undefined, null, 42, {}, []]) {
    assert.doesNotThrow(() => looksMojibake(input), `threw on ${String(input)}`);
  }
});