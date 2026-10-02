'use strict';

// Byte-level structure shared by detection, scoring and file sniffing.
//
// Mojibake is a byte-level accident, so recognising it is a byte-level job. Every
// module that needs to know "is there still an undecoded UTF-8 sequence in
// here?" asks this one module, so the definition cannot drift between the
// detector and the scorer.
//
// THE STRUCTURE
// -------------
// A character in correct UTF-8 text is encoded as a lead byte followed by
// continuation bytes:
//
//   110xxxxx 1xxxxxxx                 2-byte  lead U+0080 .. U+07FF
//   1110xxxx 1xxxxxxx 1xxxxxxx       3-byte  lead U+0800 .. U+FFFF   (€, —, “, …)
//   11110xxx 1xxxxxxx ...             4-byte  lead U+10000 .. U+10FFFF (emoji)
//
// 0xC0 and 0xC1 are excluded from the 2-byte lead range because they can only
// ever begin an overlong (illegal) encoding; 0xF5-0xFF likewise cannot begin a
// valid sequence.
//
// When such a sequence is read through a single-byte codec, the lead byte becomes
// a character in U+00C2-U+00F4 and each continuation byte (0x80-0xBF) becomes
// whatever that codec maps it to. The ADJACENCY survives; the meaning does not.
// That surviving adjacency is the signal. It is structural, so it needs no
// maintained list of artefact strings, and it does not fire on correct accented
// text -- "ça", "Müller", "Maß»" contain no lead/continuation adjacency.

const { CP1251, CP1252 } = require('./tables.js');

/**
 * Code points that a UTF-8 *continuation* byte (0x80-0xBF) can decode to under
 * any codec this project supports.
 *
 * Derived from the codec tables rather than assumed to be U+0080-U+00BF, because
 * it is not:
 *   - windows-1252 maps 0x80-0x9F to typographic punctuation (U+20AC euro,
 *     U+201A, U+2019 curly quote, U+201E, ...) via `encode(text,'cp1252')`
 *     followed by a latin1 read, which is how the classic "â‚¬" arises;
 *   - windows-1251 maps 0x80-0xBF to Ё/Ђ/Ѓ/... and typographic punctuation;
 *   - latin1 maps it to U+0080-U+00BF.
 *
 * Assuming the plain Latin-1 range would miss U+0178 (0xC3 0x9F in "Größe") and
 * would wrongly accept things it should not.
 */
const CONTINUATION = (() => {
  const set = new Set();
  // Code points reachable from bytes 0x80-0xBF in each single-byte codec.
  for (const table of [CP1251, CP1252]) {
    for (let byte = 0x80; byte <= 0xbf; byte++) set.add(table[byte]);
  }
  for (let byte = 0x80; byte <= 0xbf; byte++) set.add(byte); // latin1
  return set;
})();

/**
 * Is this code point a UTF-8 lead byte as it appears after being misdecoded
 * through latin1 or cp1252?
 *
 * Covers 2-byte (U+00C2-U+00DF), 3-byte (U+00E0-U+00EF) and 4-byte
 * (U+00F0-U+00F4) leads. U+00E2 is the lead for "€" and U+00F0 the lead for every
 * emoji, so a 2-byte-only definition would miss both.
 *
 * @param {number} cp code point
 * @returns {boolean}
 */
const isLead = (cp) => cp >= 0xc2 && cp <= 0xf4;

/** C1 control characters, U+0080-U+009F: continuation bytes that stayed raw. */
const isC1 = (cp) => cp >= 0x80 && cp <= 0x9f;

/**
 * Characters that a lead byte is immediately followed by in broken text.
 *
 * @param {number} cp code point of the second character
 * @returns {boolean}
 */
const isContinuation = (cp) => isC1(cp) || CONTINUATION.has(cp);

/**
 * Scan text for surviving UTF-8 byte pairs.
 *
 * A "pair" is a lead byte immediately followed by a continuation character. Only
 * the lead character is counted, so a 3-byte sequence contributes one pair, and the
 * ratio is computed over characters rather than pairs.
 *
 * @param {string} text
 * @returns {{ pairs: number, covered: number, ratio: number }}
 *   pairs: number of lead/continuation adjacencies found
 *   covered: number of characters involved (2 per pair, since each pair is 2 chars)
 *   ratio: covered / nonAscii, or 0 when the text is pure ASCII
 */
function scanPairs(text) {
  const chars = [...String(text)];
  let nonAscii = 0;
  for (const ch of chars) if (ch.codePointAt(0) >= 0x80) nonAscii++;

  let pairs = 0;
  for (let i = 0; i + 1 < chars.length; i++) {
    if (!isLead(chars[i].codePointAt(0))) continue;
    if (isContinuation(chars[i + 1].codePointAt(0))) pairs++;
  }
  return {
    pairs,
    covered: pairs * 2,
    ratio: nonAscii === 0 ? 0 : (pairs * 2) / nonAscii,
  };
}

module.exports = Object.freeze({
  CONTINUATION,
  isC1,
  isContinuation,
  isLead,
  scanPairs,
});