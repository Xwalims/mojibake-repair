'use strict';

const fs = require('fs');
const path = require('path');

// Regenerates src/tables.js byte tables from Node's own TextDecoder, which
// implements the WHATWG Encoding Standard's single-byte decoders. Run after a
// Node upgrade and diff the result:
//
//   node scripts/gen-tables.js && git diff --exit-code src/tables.js
//
// Only the two table literals are emitted; the surrounding prose is kept in
// src/tables.js by hand.

function table(encoding) {
  const decoder = new TextDecoder(encoding, { fatal: true });
  const rows = [];
  for (let byte = 0; byte < 256; byte++) {
    let decoded;
    try {
      decoded = decoder.decode(Uint8Array.of(byte));
    } catch {
      decoded = null; // byte not defined in this codec
    }
    rows.push(decoded === null ? null : `0x${decoded.codePointAt(0).toString(16)}`);
  }
  return rows;
}

function literal(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += 16) {
    const chunk = rows
      .slice(i, i + 16)
      .map((v) => (v === null ? 'null' : v))
      .join(', ');
    out.push(`  ${chunk},`);
  }
  return `[\n${out.join('\n')}\n]`;
}

const current = fs.readFileSync(path.join(__dirname, '..', 'src', 'tables.js'), 'utf8');
const cp1251 = literal(table('windows-1251'));
const cp1252 = literal(table('windows-1252'));

let changed = false;
let next = current;
if (!next.includes(cp1251)) {
  next = next.replace(/const CP1251 = \[[\s\S]*?\n\];/, `const CP1251 = ${cp1251};`);
  changed = true;
}
if (!next.includes(cp1252)) {
  next = next.replace(/const CP1252 = \[[\s\S]*?\n\];/, `const CP1252 = ${cp1252};`);
  changed = true;
}

const dest = path.join(__dirname, '..', 'src', 'tables.js');
if (changed) {
  fs.writeFileSync(dest, next);
  console.log('src/tables.js updated from TextDecoder tables');
} else {
  console.log('src/tables.js already matches TextDecoder tables');
}