'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { CP1251, CP1252, REVERSE_CP1251, REVERSE_CP1252, buildReverse } = require('../src/tables.js');

// The vendored tables must agree byte-for-byte with Node's own WHATWG
// implementation, otherwise every repair built on them is a guess.
for (const [name, table] of [['windows-1251', CP1251], ['windows-1252', CP1252]]) {
  test(`tables: ${name} matches TextDecoder for all 256 bytes`, () => {
    const decoder = new TextDecoder(name, { fatal: true });
    for (let byte = 0; byte < 256; byte++) {
      let expected = null;
      try {
        expected = decoder.decode(Uint8Array.of(byte)).codePointAt(0);
      } catch {
        expected = null;
      }
      assert.equal(
        table[byte],
        expected,
        `byte 0x${byte.toString(16)} of ${name}`
      );
    }
  });
}

test('tables: every entry is a code point or null', () => {
  for (const table of [CP1251, CP1252]) {
    assert.equal(table.length, 256);
    for (const cp of table) {
      assert.ok(cp === null || (Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff), `bad ${cp}`);
    }
  }
});

test('tables: known code points are correct', () => {
  assert.equal(CP1251[0xc0], 0x410); // А CYRILLIC CAPITAL A
  assert.equal(CP1251[0xe0], 0x430); // а cyrillic small a
  assert.equal(CP1251[0xdd], 0x42d); // Э CYRILLIC CAPITAL LETTER REVERSED E
  assert.equal(CP1251[0xfd], 0x44d); // э cyrillic small reversed ye
  assert.equal(CP1251[0xfe], 0x44e); // ю
  assert.equal(CP1251[0xff], 0x44f); // я
  assert.equal(CP1252[0x92], 0x2019); // right single quote
  assert.equal(CP1252[0xe9], 0xe9); // é
  assert.equal(CP1252[0xa0], 0xa0); // nbsp
  assert.equal(CP1252[0x80], 0x20ac); // euro sign
});

test('buildReverse: lowest byte wins on aliases and is deterministic', () => {
  const forward = [0x41, 0x41, null, 0x42];
  const reverse = buildReverse(forward);
  assert.equal(reverse.get(0x41), 0); // lowest, not the later alias
  assert.equal(reverse.get(0x42), 3);
  assert.equal(reverse.size, 2); // null contributes nothing
});

test('buildReverse: pure function, equal inputs give equal maps', () => {
  assert.deepEqual(buildReverse(CP1251), buildReverse(CP1251));
});

test('tables: reverse maps cover every defined code point', () => {
  for (const [forward, reverse] of [
    [CP1251, REVERSE_CP1251],
    [CP1252, REVERSE_CP1252],
  ]) {
    const defined = new Set(forward.filter((cp) => cp !== null));
    for (const cp of defined) {
      assert.ok(reverse.has(cp), `0x${cp.toString(16)} missing from reverse map`);
    }
    for (const byte of reverse.keys()) {
      assert.ok(forward[byte] !== null, `reverse map has an undefined byte ${byte}`);
    }
  }
});