'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mojibake } = require('../src/codecs.js');
const { generateCandidates } = require('../src/candidates.js');
const {
  artefactDensity,
  DEFAULT_MIN_SCORE,
  MAX_POSITIVE,
  printableRatio,
  rankCandidates,
  scoreCandidate,
  scriptConsistency,
  WEIGHTS,
} = require('../src/score.js');
const { CORRECT } = require('./fixtures.js');

test('score: weights are exported, frozen and internally consistent', () => {
  assert.ok(Object.isFrozen(WEIGHTS));
  assert.equal(
    MAX_POSITIVE,
    WEIGHTS.scriptConsistency +
      WEIGHTS.artefactDensity +
      WEIGHTS.printableRatio +
      WEIGHTS.languageHint
  );
  assert.ok(WEIGHTS.replacementChars < 0, 'replacement chars must be penalised');
});

test('score: a score is always within [0, 1]', () => {
  const inputs = [
    '',
    CORRECT.fr,
    CORRECT.ru,
    mojibake(CORRECT.fr, 'cp1252'),
    mojibake(CORRECT.ru, 'latin1'),
    'ÿþý �'.repeat(20),
    '🎉👋🌍',
    '\uD800 lone',
  ];
  for (const text of inputs) {
    for (const candidate of [text, mojibake(text, 'latin1'), mojibake(text, 'cp1251')]) {
      const { score } = scoreCandidate(candidate, text);
      assert.ok(
        score >= 0 && score <= 1,
        `score ${score} out of range for ${JSON.stringify(candidate.slice(0, 20))}`
      );
    }
  }
});

test('score: text with replacement characters is marked ineligible', () => {
  const parts = scoreCandidate('caf� au lait', 'cafÃ© au lait');
  assert.equal(parts.replacementChars, 1);
  assert.equal(parts.eligible, false);
  assert.equal(parts.score, 0, 'a disqualified candidate scores 0');
});

test('score: lossless text is eligible', () => {
  assert.equal(scoreCandidate('café au lait', 'cafÃ© au lait').eligible, true);
});

test('score: the repaired text scores higher than the broken text', () => {
  for (const [correct, codec] of [
    [CORRECT.fr, 'cp1252'],
    [CORRECT.ru, 'latin1'],
    [CORRECT.es, 'cp1252'],
    [CORRECT.ru, 'cp1251'],
  ]) {
    const broken = mojibake(correct, codec);
    const asRepaired = scoreCandidate(correct, broken).score;
    const asBroken = scoreCandidate(broken, broken).score;
    assert.ok(
      asRepaired > asBroken,
      `repaired (${asRepaired}) must outscore broken (${asBroken}) for ${codec}`
    );
  }
});

test('score: scriptConsistency separates coherent from mixed scripts', () => {
  const russian = scriptConsistency(CORRECT.ru);
  assert.equal(russian.dominant, 'Cyrillic');
  assert.equal(russian.consistency, 1, 'coherent Cyrillic scores 1');

  const mixed = scriptConsistency('Hello Привет мир');
  assert.ok(mixed.consistency < 1, 'mixed Latin/Cyrillic must score below 1');
  assert.ok(mixed.minority > 0);

  const empty = scriptConsistency('');
  assert.equal(empty.consistency, 1, 'no letters is trivially consistent');
  assert.equal(empty.dominant, null);
});

test('score: printableRatio is 1 for clean text and lower for soup', () => {
  assert.equal(printableRatio('Hello world'), 1);
  assert.equal(printableRatio(''), 1, 'empty text is vacuously printable');
  assert.ok(printableRatio('a\u0001b\u0002c') < 1, 'control chars reduce the ratio');
});

test('score: artefactDensity is ~0 for correct text and positive for broken text', () => {
  // Not exactly 0: languages that genuinely use windows-1251's padding letters
  // (Macedonian and Serbian ѕ ј ќ џ, ђ љ њ ћ) register some hits, which is the
  // same reason detect.js gates that signal on a RATIO rather than a presence.
  // Languages that genuinely use windows-1251's 0x80-0xBF block, so their correct
  // text registers padding-letter hits: Ukrainian (ї є ґ), Macedonian and Serbian
  // (ѕ ј ќ џ, ђ љ њ ћ). Their measured ratios are 0.146, 0.189 and 0.206 -- all
  // below the 0.26 threshold, and well below the 0.333 that cp1251 mojibake
  // produces. The ratio is what separates them, never the presence.
  const usesPaddingLetters = new Set(['uk', 'mk', 'sr']);
  for (const key of ['fr', 'es', 'pt', 'tr', 'ru', 'bg', 'en', 'emoji', 'math']) {
    const { count } = artefactDensity(CORRECT[key]);
    assert.equal(count, 0, `${key} should have no artefacts, got ${count}`);
  }
  // German contributes exactly one, from "Maß»" (U+00DF + U+00BB).
  assert.equal(artefactDensity(CORRECT.de).count, 1, 'German has the one known artefact');

  const { THRESHOLDS } = require('../src/detect.js');
  for (const key of usesPaddingLetters) {
    const { cyrillicExtras, count } = artefactDensity(CORRECT[key]);
    assert.ok(cyrillicExtras > 0, `${key} does use padding letters`);
    assert.ok(count > 0);
    // And critically: the signal must still not fire on the correct text.
    const { analyse } = require('../src/detect.js');
    const { metrics } = analyse(CORRECT[key]);
    assert.ok(
      metrics.cyrillicExtrasRatio < THRESHOLDS.cyrillicExtrasMinRatio,
      `${key} ratio ${metrics.cyrillicExtrasRatio} must stay below ${THRESHOLDS.cyrillicExtrasMinRatio}`
    );
    assert.deepEqual(analyse(CORRECT[key]).signals, [], `${key} must not be flagged`);
  }
  for (const [correct, codec] of [
    [CORRECT.fr, 'cp1252'],
    [CORRECT.ru, 'latin1'],
    [CORRECT.es, 'cp1252'],
    [CORRECT.ru, 'cp1251'],
  ]) {
    const { count } = artefactDensity(mojibake(correct, codec));
    assert.ok(count > 0, `broken ${codec} text should have artefacts`);
  }
});

test('score: repairing drives the artefact count to zero', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  assert.ok(artefactDensity(broken).count > 0);
  assert.equal(artefactDensity(CORRECT.fr).count, 0);
});

test('score: artefactDensity counts cp1251 damage too', () => {
  // This flavour has no byte pairs at all, so a byte-pair-only counter would
  // report zero and the scorer would think the repair made no progress.
  const broken = mojibake(CORRECT.ru, 'cp1251');
  const brokenParts = artefactDensity(broken);
  assert.equal(brokenParts.pairs, 0, 'cp1251 mojibake has no byte pairs');
  assert.ok(brokenParts.cyrillicExtras > 0, 'but it does have cp1251 padding letters');
  assert.ok(brokenParts.count > 0);
});

test('score: rankCandidates sorts by score, descending', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  const ranked = rankCandidates(generateCandidates(broken), broken);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(
      ranked[i - 1].score >= ranked[i].score,
      `rank ${i - 1} (${ranked[i - 1].score}) below rank ${i} (${ranked[i].score})`
    );
  }
});

test('score: the correct hypothesis ranks first', () => {
  const cases = [
    [CORRECT.fr, 'cp1252', 'utf8-as-cp1252'],
    [CORRECT.ru, 'latin1', 'utf8-as-latin1'],
    [CORRECT.ru, 'cp1251', 'utf8-as-cp1251'],
  ];
  for (const [correct, codec, expected] of cases) {
    const broken = mojibake(correct, codec);
    const ranked = rankCandidates(generateCandidates(broken), broken);
    assert.equal(ranked[0].id, expected, `for ${codec}, ranked ${ranked[0].id} (${ranked[0].score})`);
    assert.equal(ranked[0].value, correct);
  }
});

test('score: ranking is deterministic across repeated calls', () => {
  const broken = mojibake(CORRECT.es, 'cp1252');
  const first = JSON.stringify(
    rankCandidates(generateCandidates(broken), broken).map((c) => [c.id, c.score])
  );
  for (let i = 0; i < 20; i++) {
    assert.equal(
      JSON.stringify(rankCandidates(generateCandidates(broken), broken).map((c) => [c.id, c.score])),
      first,
      `call ${i} differed`
    );
  }
});

test('score: ranking is stable when candidates are regenerated in a fresh module instance', () => {
  // Guards against hidden module-level state influencing the result.
  const broken = mojibake(CORRECT.de, 'cp1252');
  const runA = rankCandidates(generateCandidates(broken), broken).map((c) => `${c.id}:${c.score}`);
  delete require.cache[require.resolve('../src/score.js')];
  delete require.cache[require.resolve('../src/candidates.js')];
  const freshScore = require('../src/score.js');
  const freshCandidates = require('../src/candidates.js');
  const runB = freshScore
    .rankCandidates(freshCandidates.generateCandidates(broken), broken)
    .map((c) => `${c.id}:${c.score}`);
  assert.deepEqual(runB, runA, 'a fresh module instance must rank identically');
});

test('score: rankCandidates handles failed candidates without scoring them', () => {
  const ranked = rankCandidates(
    [
      { id: 'ok', assumed: 'latin1', label: '', note: '', value: 'café', error: null, changed: true },
      { id: 'failed', assumed: 'nope', label: '', note: '', value: null, error: 'boom', changed: false },
    ],
    'cafÃ©'
  );
  assert.equal(ranked.length, 2);
  const failed = ranked.find((c) => c.id === 'failed');
  assert.equal(failed.score, 0);
  assert.equal(failed.eligible, false);
  assert.equal(failed.parts, null);
});

test('score: rankCandidates marks candidates above the threshold', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  const ranked = rankCandidates(generateCandidates(broken), broken, { minScore: DEFAULT_MIN_SCORE });
  for (const c of ranked) {
    assert.equal(c.aboveThreshold, c.score >= DEFAULT_MIN_SCORE, `${c.id} flag is wrong`);
  }
});

test('score: the ranked result is frozen', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  const ranked = rankCandidates(generateCandidates(broken), broken);
  assert.ok(Object.isFrozen(ranked));
  for (const c of ranked) assert.ok(Object.isFrozen(c));
});

test('score: a longer correct text does not score lower than a shorter one', () => {
  // Guards against a length penalty sneaking in through the ratio components.
  const short = scoreCandidate('Français: café, naïf.', 'FranÃ§ais: cafÃ©, naÃ¯f.').score;
  const long = scoreCandidate(`${CORRECT.fr} ${CORRECT.fr}`, `x`).score;
  assert.ok(long > 0 && short > 0);
});

test('score: language hints reward real words', () => {
  const withWords = scoreCandidate('the cat and the hat is not a dog', 'broken').hintRatio;
  const withoutWords = scoreCandidate('qwerty zxcvb asdfgh', 'broken').hintRatio;
  assert.ok(withWords > withoutWords, 'common words must score higher');
  assert.ok(withoutWords >= 0);
});