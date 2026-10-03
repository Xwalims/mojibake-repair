'use strict';

// Regenerates src/tables.js from the NORMATIVE WHATWG index files vendored in
// spec/, not from any runtime:
//
//   node scripts/gen-tables.js && git diff --exit-code src/tables.js
//
// The previous version generated from Node's own TextDecoder and called it "the
// WHATWG reference implementation". That was wrong: Node 20's ICU decodes
// windows-1252 as ISO-8859-1 (byte 0x80 -> U+0080, not U+20AC), so on Node 20
// the generator silently rewrote the correct C1 block into a latin1 identity
// table and CI failed on Node 20 while passing on 22/24. The standard is the
// oracle; a runtime is only a convenience. See spec/README.md for provenance.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Parse a WHATWG single-byte index file: 128 rows mapping 0x80-0xFF to code
 * points, keyed 0..127.
 * @param {string} file
 * @returns {number[]}
 */
function readIndex(file) {
  const rows = [];
  for (const line of fs.readFileSync(path.join(ROOT, 'spec', file), 'utf8').split('\n')) {
    const match = /^\s*(\d+)\s+0x([0-9A-Fa-f]+)\s/.exec(line);
    if (match) rows.push(Number('0x' + match[2]));
  }
  if (rows.length !== 128) {
    throw new Error(`${file}: expected 128 index rows, got ${rows.length}`);
  }
  return rows;
}

/**
 * Full 256-entry table: 0x00-0x7F map to the identical code point, then the
 * index rows.
 * @param {string} file
 * @returns {number[]}
 */
function table(file) {
  const ascii = [];
  for (let byte = 0; byte < 0x80; byte++) ascii.push(byte);
  return ascii.concat(readIndex(file));
}

function literal(values) {
  const lines = [];
  for (let i = 0; i < values.length; i += 16) {
    const chunk = values.slice(i, i + 16).map((v) => '0x' + v.toString(16));
    lines.push(`  ${chunk.join(', ')},`);
  }
  return `[\n${lines.join('\n')}\n]`;
}

const current = fs.readFileSync(path.join(ROOT, 'src', 'tables.js'), 'utf8');
const tables = [
  ['CP1251', table('index-windows-1251.txt')],
  ['CP1252', table('index-windows-1252.txt')],
];

let next = current;
let changed = false;
for (const [name, values] of tables) {
  const rendered = literal(values);
  if (!next.includes(rendered)) {
    next = next.replace(new RegExp(`const ${name} = \\[[\\s\\S]*?\\n\\];`), `const ${name} = ${rendered};`);
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(path.join(ROOT, 'src', 'tables.js'), next);
  console.log('src/tables.js updated from the WHATWG index files in spec/');
} else {
  console.log('src/tables.js already matches the WHATWG index files in spec/');
}