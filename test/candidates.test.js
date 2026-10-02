'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mojibake } = require('../src/codecs.js');
const {
  applicableStrategies,
  attempt,
  generateCandidates,
  STRATEGIES,
  STRATEGY_BY_ID,
  STRATEGY_IDS,
} = require('../src/candidates.js');
const { CORRECT } = require('./fixtures.js');

test('candidates: every documented strategy is present', () => {
  for (const id of [
    'utf8-as-latin1',
    'utf8-as-cp1251',
    'utf8-as-cp1252',
    'latin1-as-utf8',
    'cp1251-as-utf8',
    'cp1252-as-utf8',
  ]) {
    assert.ok(STRATEGY_IDS.includes(id), `missing strategy ${id}`);
    assert.ok(STRATEGY_BY_ID.get(id), `no strategy object for ${id}`);
  }
});

test('candidates: the strategy list is frozen and ordered deterministically', () => {
  assert.ok(Object.isFrozen(STRATEGIES));
  assert.deepEqual(
    STRATEGY_IDS,
    [
      'utf8-as-latin1',
      'utf8-as-cp1252',
      'utf8-as-cp1251',
      'latin1-as-utf8',
      'cp1251-as-utf8',
      'cp1252-as-utf8',
    ]
  );
  for (const strategy of STRATEGIES) {
    assert.ok(Object.isFrozen(strategy));
    assert.ok(typeof strategy.note === 'string' && strategy.note.length > 10);
    assert.ok(typeof strategy.label === 'string');
  }
});

test('candidates: generation order matches STRATEGIES order', () => {
  const generated = generateCandidates(mojibake(CORRECT.fr, 'cp1252'));
  assert.deepEqual(
    generated.map((c) => c.id),
    STRATEGY_IDS.filter((id) => applicableStrategies(mojibake(CORRECT.fr, 'cp1252')).some((s) => s.id === id))
  );
});

test('candidates: the correct hypothesis is generated for every broken case', () => {
  const cases = [
    [CORRECT.fr, 'cp1252', 'utf8-as-cp1252'],
    [CORRECT.fr, 'latin1', 'utf8-as-latin1'],
    [CORRECT.ru, 'latin1', 'utf8-as-latin1'],
    [CORRECT.ru, 'cp1251', 'utf8-as-cp1251'],
  ];
  for (const [correct, codec, expected] of cases) {
    const generated = generateCandidates(mojibake(correct, codec));
    const found = generated.find((c) => c.id === expected);
    assert.ok(found, `no ${expected} candidate for ${codec}`);
    if (found.value !== null) {
      assert.equal(found.value, correct, `${expected} produced the wrong value for ${codec}`);
    }
  }
});

test('candidates: pure ASCII generates no candidates', () => {
  // A latin1 round trip on ASCII is the identity transform: it can never win and
  // would only clutter the ranking.
  assert.deepEqual(generateCandidates(CORRECT.ascii), []);
  assert.deepEqual(generateCandidates(''), []);
});

test('candidates: empty input generates nothing and does not throw', () => {
  assert.deepEqual(generateCandidates(''), []);
  assert.doesNotThrow(() => generateCandidates(''));
});

test('candidates: every attempt is total -- no input throws', () => {
  const hostile = [
    '',
    'plain ascii',
    'Ã'.repeat(100),
    '\uD800', // lone surrogate
    `\uD800\uDC00${String.fromCharCode(0x80, 0x81, 0x8d, 0x8f, 0x90, 0x9d)}`,
    'ÿþý',
    '�'.repeat(20),
    '\u0000\u0001\u0002',
    String.fromCharCode(0xfffe, 0xffff),
    '🎉👋🌍' + 'é'.repeat(50),
  ];
  for (const text of hostile) {
    assert.doesNotThrow(() => generateCandidates(text), `threw on ${JSON.stringify(text)}`);
  }
});

test('candidates: a failed attempt records the error instead of crashing', () => {
  // An artificially impossible strategy: a codec that cannot represent anything.
  const bogus = {
    id: 'bogus',
    assumed: 'definitely-not-a-codec',
    label: 'bogus',
    note: 'test',
  };
  const result = attempt(bogus, 'some text');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.match(result.error, /unknown encoding/i);
});

test('candidates: generated candidates are frozen with all fields present', () => {
  const generated = generateCandidates(mojibake(CORRECT.ru, 'latin1'));
  for (const candidate of generated) {
    assert.ok(Object.isFrozen(candidate));
    for (const field of ['id', 'label', 'assumed', 'note', 'value', 'error', 'changed']) {
      assert.ok(field in candidate, `missing ${field}`);
    }
    assert.ok(candidate.value === null || typeof candidate.value === 'string');
  }
});

test('candidates: strategies can be restricted by id', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  const generated = generateCandidates(broken, { strategies: ['utf8-as-cp1252'] });
  assert.equal(generated.length, 1);
  assert.equal(generated[0].id, 'utf8-as-cp1252');
});

test('candidates: generation is deterministic', () => {
  const broken = mojibake(CORRECT.es, 'cp1252');
  const first = JSON.stringify(generateCandidates(broken));
  for (let i = 0; i < 10; i++) {
    assert.equal(JSON.stringify(generateCandidates(broken)), first);
  }
});

test('candidates: applicableStrategies reflects the non-ASCII content', () => {
  assert.equal(applicableStrategies(CORRECT.ascii).length, 0);
  assert.equal(applicableStrategies('').length, 0);
  assert.equal(applicableStrategies('café').length, STRATEGIES.length);
});

test('candidates: the changed flag reflects reality', () => {
  const broken = mojibake(CORRECT.fr, 'cp1252');
  for (const candidate of generateCandidates(broken)) {
    if (candidate.value === null) continue;
    assert.equal(candidate.changed, candidate.value !== broken, `${candidate.id} flag is wrong`);
  }
});