'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { CP1251, CP1252, REVERSE_CP1251, REVERSE_CP1252, buildReverse } = require('../src/tables.js');

/**
 * The normative WHATWG index, parsed from spec/. This is the oracle, NOT
 * TextDecoder: Node 20's ICU decodes windows-1252 as ISO-8859-1 (0x80 -> U+0080
 * instead of U+20AC), so agreeing with the runtime would mean shipping the wrong
 * table on whichever Node version the machine happens to have.
 * @param {string} file index file name in spec/
 * @returns {number[]} 128 code points for bytes 0x80-0xFF
 */
function whatwgIndex(file) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'spec', file), 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+0x([0-9A-Fa-f]+)\s/.exec(line);
    if (match) rows.push(Number('0x' + match[2]));
  }
  assert.equal(rows.length, 128, `${file}: expected 128 index rows`);
  return rows;
}

const SPEC = [
  ['windows-1251', CP1251, 'index-windows-1251.txt'],
  ['windows-1252', CP1252, 'index-windows-1252.txt'],
];

// The vendored tables must agree with the standard byte for byte, otherwise
// every repair built on them is a guess.
for (const [name, table, file] of SPEC) {
  test(`tables: ${name} matches the WHATWG index for all 256 bytes`, () => {
    const index = whatwgIndex(file);
    for (let byte = 0; byte < 256; byte++) {
      const expected = byte < 0x80 ? byte : index[byte - 0x80];
      assert.equal(
        table[byte],
        expected,
        `byte 0x${byte.toString(16)} of ${name}`
      );
    }
  });
}

test('tables: the vendored index files are the unmodified WHATWG ones', () => {
  // Guards against someone hand-editing spec/ to make a table check pass.
  // The identifiers are the ones upstream published with these files.
  const identifiers = {
    'index-windows-1251.txt':
      '7592ef921679ba168b00a9e9afa3b4eebd67bf13dc7e84c4b6e120de856826e0',
    'index-windows-1252.txt':
      'e56d49d9176e9a412283cf29ac9bd613f5620462f2a080a84eceaf974cfa18b7',
  };
  for (const [file, id] of Object.entries(identifiers)) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'spec', file), 'utf8');
    assert.match(
      text,
      new RegExp(`^# Identifier: ${id}$`, 'm'),
      `${file}: upstream Identifier header is missing or changed`
    );
  }
});

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