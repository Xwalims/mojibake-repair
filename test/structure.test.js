'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mojibake } = require('../src/codecs.js');
const { CONTINUATION, isC1, isContinuation, isLead, scanPairs } = require('../src/structure.js');
const { CORRECT } = require('./fixtures.js');

test('structure: the lead range covers 2, 3 and 4 byte UTF-8 sequences', () => {
  // 2-byte: U+00C2-U+00DF leads (é, ü, Cyrillic)
  assert.ok(isLead(0xc2), '0xC2 is a 2-byte lead');
  assert.ok(isLead(0xdf), '0xDF is a 2-byte lead');
  // 3-byte: U+00E0-U+00EF leads (€ is 0xE2, — is 0xE2, CJK is 0xE4-0xE9)
  assert.ok(isLead(0xe2), '0xE2 leads the euro sign, a 3-byte sequence');
  assert.ok(isLead(0xef), '0xEF is a 3-byte lead');
  // 4-byte: U+00F0-U+00F4 leads (every emoji starts with 0xF0)
  assert.ok(isLead(0xf0), '0xF0 leads emoji, a 4-byte sequence');
  assert.ok(isLead(0xf4), '0xF4 is the highest valid 4-byte lead');
});

test('structure: the lead range excludes bytes that cannot lead a valid sequence', () => {
  // 0xC0/0xC1 could only begin an overlong (illegal) encoding.
  assert.equal(isLead(0xc0), false);
  assert.equal(isLead(0xc1), false);
  // 0xF5-0xFF would exceed U+10FFFF.
  assert.equal(isLead(0xf5), false);
  assert.equal(isLead(0xff), false);
  assert.equal(isLead(0x41), false, 'ASCII is not a lead');
});

test('structure: the euro sign and emoji are detected as broken, not missed', () => {
  // Regression: a 2-byte-only lead range (U+00C2-U+00DF) silently missed every
  // 3-byte and 4-byte sequence, so broken "€" and broken emoji looked clean.
  const brokenEuro = mojibake('Preis: 10€', 'cp1252');
  assert.ok(brokenEuro !== 'Preis: 10€', 'fixture must be broken');
  assert.ok(scanPairs(brokenEuro).pairs > 0, 'a broken euro sign must be detected');

  const brokenEmoji = mojibake('hi 👋', 'cp1252');
  assert.ok(scanPairs(brokenEmoji).pairs > 0, 'broken emoji must be detected');

  const cleanEmoji = scanPairs('hi 👋');
  assert.equal(cleanEmoji.pairs, 0, 'correct emoji must not be flagged');
});

test('structure: C1 control characters are continuation bytes that stayed raw', () => {
  for (let cp = 0x80; cp <= 0x9f; cp++) assert.ok(isC1(cp), `U+${cp.toString(16)} is C1`);
  assert.equal(isC1(0x7f), false);
  assert.equal(isC1(0xa0), false);
});

test('structure: CONTINUATION is derived from the codec tables, not the Latin-1 range', () => {
  // U+0178 comes from 0xC3 0x9F read through cp1252 (German "Größe"). It lies
  // OUTSIDE U+0080-U+00BF, so a range-based definition would miss it.
  assert.ok(CONTINUATION.has(0x0178), 'U+0178 must be recognised as a continuation');
  // windows-1252 maps 0x80-0x9F to typographic punctuation.
  assert.ok(CONTINUATION.has(0x2019), 'U+2019 (curly quote) must be a continuation');
  assert.ok(CONTINUATION.has(0x20ac), 'U+20AC (euro) must be a continuation');
  // windows-1251 maps 0x80-0xBF to Cyrillic padding letters (ј, ќ, џ, ѕ, ...).
  assert.ok(CONTINUATION.has(0x0458), 'U+0458 (ј) must be a continuation');
  assert.ok(CONTINUATION.has(0x0453), 'U+0453 (ѕ) must be a continuation');
  assert.ok(CONTINUATION.has(0x0490), 'U+0490 (А) must be a continuation');
  // latin1 gives the obvious U+0080-U+00BF range, so 0xA9 (the second byte of
  // the UTF-8 encoding of "é") is a continuation...
  assert.ok(CONTINUATION.has(0x00a9), 'U+00A9 must be a continuation');
  // ...but "é" ITSELF (U+00E9) is not one: a continuation byte is always in
  // 0x80-0xBF, and U+00E9 is above it. Getting this backwards would flag correct
  // accented text on sight.
  assert.equal(CONTINUATION.has(0x00e9), false, 'U+00E9 is not a continuation byte');
  assert.ok(!isContinuation(0x00e9), 'a correct accented letter must not read as a continuation');
  // ASCII is never a continuation.
  assert.equal(CONTINUATION.has(0x41), false);
  assert.equal(isContinuation(0x41), false);
});

test('structure: isContinuation accepts both C1 and table lookups', () => {
  assert.ok(isContinuation(0x80));
  assert.ok(isContinuation(0x0178));
  assert.equal(isContinuation(0x41), false);
  assert.equal(isContinuation(0x20ac + 1), false);
});

test('structure: German ß» does produce a pair, and the count guard is what saves it', () => {
  // "ß»" is U+00DF followed by U+00BB. U+00DF falls in the lead range and
  // U+00BB is a continuation character, so this DOES count as a byte pair -- and
  // that is honest, because the two characters are indistinguishable from a
  // misdecoded sequence at this level.
  //
  // Correct German is not saved by a smarter pair definition; it is saved by the
  // two guards in detect.js: a MINIMUM PAIR COUNT of 2 (correct German produces
  // 1) and a minimum ratio (correct German produces 0.10 against a threshold of
  // 0.50). Broken German produces 20 pairs at ratio 0.98. Measured, not assumed.
  assert.equal(scanPairs('Maß»').pairs, 1, 'the pair is real; it must be filtered, not denied');

  const { measure, analyse, THRESHOLDS } = require('../src/detect.js');
  const correctGerman = measure(CORRECT.de);
  assert.equal(correctGerman.utf8Pairs, 1, 'correct German produces exactly one pair');
  assert.ok(correctGerman.utf8Pairs < THRESHOLDS.utf8PairMinPairs, 'below the minimum pair count');
  assert.ok(correctGerman.utf8PairRatio < THRESHOLDS.utf8PairMinRatio, 'below the minimum ratio');
  assert.equal(analyse(CORRECT.de).signals.length, 0, 'so no signal fires');

  const brokenGerman = scanPairs(mojibake(CORRECT.de, 'cp1252'));
  assert.ok(brokenGerman.pairs >= THRESHOLDS.utf8PairMinPairs, 'broken German clears the count');
  assert.ok(brokenGerman.ratio >= THRESHOLDS.utf8PairMinRatio, 'broken German clears the ratio');
});

test('structure: correct text of every language stays below the detection guards', () => {
  // Not necessarily zero: German produces 1 pair from "Maß»". What matters, and
  // what is asserted here, is that no correct sample clears either guard, which
  // is the property detect.js actually depends on.
  const { THRESHOLDS } = require('../src/detect.js');
  for (const [key, text] of Object.entries(CORRECT)) {
    const scanned = scanPairs(text);
    const clearsCount = scanned.pairs >= THRESHOLDS.utf8PairMinPairs;
    const clearsRatio = scanned.ratio >= THRESHOLDS.utf8PairMinRatio;
    assert.ok(
      !(clearsCount && clearsRatio),
      `${key} would be flagged: pairs=${scanned.pairs} ratio=${scanned.ratio.toFixed(2)}`
    );
  }
});

test('structure: every language except German scans to exactly zero pairs', () => {
  for (const [key, text] of Object.entries(CORRECT)) {
    if (key === 'de') continue; // "Maß»", covered by the test above
    const { pairs } = scanPairs(text);
    assert.equal(pairs, 0, `${key} produced ${pairs} pairs: ${JSON.stringify(text.slice(0, 40))}`);
  }
});

test('structure: broken text produces pairs', () => {
  const cases = [
    [CORRECT.fr, 'cp1252'],
    [CORRECT.fr, 'latin1'],
    [CORRECT.es, 'cp1252'],
    [CORRECT.de, 'cp1252'],
    [CORRECT.ru, 'latin1'],
    [CORRECT.tr, 'latin1'],
  ];
  for (const [correct, codec] of cases) {
    const { pairs } = scanPairs(mojibake(correct, codec));
    assert.ok(pairs > 0, `broken ${codec} text produced no pairs`);
  }
});

test('structure: scanPairs ratio is zero for pure ASCII and bounded otherwise', () => {
  assert.equal(scanPairs('plain ascii text').ratio, 0);
  assert.equal(scanPairs('').ratio, 0);
  for (const [correct, codec] of [[CORRECT.fr, 'cp1252'], [CORRECT.ru, 'latin1']]) {
    const { ratio, pairs, covered } = scanPairs(mojibake(correct, codec));
    assert.ok(ratio > 0 && ratio <= 1, `ratio ${ratio} out of range`);
    assert.equal(covered, pairs * 2, 'covered counts two characters per pair');
  }
});

test('structure: a 3-byte sequence counts as one pair, not three', () => {
  // "€" is E2 82 AC: one lead followed by two continuations. It must count once.
  const broken = mojibake('€', 'latin1');
  const { pairs, covered } = scanPairs(broken);
  assert.equal(pairs, 1, 'one 3-byte sequence is one pair');
  assert.equal(covered, 2, 'the lead is what gets counted');
});

test('structure: overlapping candidates are not double-counted', () => {
  // "Ã©Ã©" has two separate pairs; the second lead must not be skipped.
  const scanned = scanPairs('Ã©Ã©');
  assert.equal(scanned.pairs, 2);
});

test('structure: scanPairs never throws on hostile input', () => {
  for (const text of ['', '\uD800', '🎉👋', '\u0000\u0001', 'ÿ'.repeat(500)]) {
    assert.doesNotThrow(() => scanPairs(text), JSON.stringify(text));
  }
});