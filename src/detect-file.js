'use strict';

// File-level encoding sniffing.
//
// Works on the Buffer, never on a decoded string, because the whole question is
// which bytes are present -- and a string has already thrown that information
// away. (Buffer.toString('utf8') on invalid bytes substitutes U+FFFD, so a
// "does this contain NUL?" test run after decoding gives the wrong answer for a
// UTF-16 file.)
//
// UTF-8 is validated structurally: a byte sequence that decodes cleanly as
// well-formed UTF-8 is UTF-8, and one that does not is not. That is the only
// check with real teeth; BOMs are decisive when present but absent far more often
// than not, so they raise confidence rather than settle it.

/** Byte-order marks, as [bytes, name]. */
const BOMS = Object.freeze([
  Object.freeze([[0xef, 0xbb, 0xbf], 'utf8']),
  Object.freeze([[0xff, 0xfe], 'utf16le']),
  Object.freeze([[0xfe, 0xff], 'utf16be']),
]);

/** Encodings this module can name. */
const ENCODINGS = Object.freeze(['utf8', 'utf16le', 'utf16be', 'latin1', 'binary']);

/**
 * Minimum buffer size before a UTF-16 plausibility score may be trusted on its
 * own. Measured: a two-byte buffer scores 1.000, because a single UTF-16 code
 * unit is 100% plausible by definition -- 0x61 0x00 is "a" and 0x00 0x61 is a
 * CJK-extension character, and each is judged alone. Three bytes do the same.
 * The first non-trivial negatives appear at 5 bytes (0.250) and 6 bytes (0.500),
 * and from 7 bytes up every latin1, cp1252, UTF-8 and binary sample measured
 * scores 0.000 except a 37-byte JSON document at 0.250.
 */
const UTF16_MIN_BYTES = 8;

/**
 * Minimum plausibility score for the correct byte order, when the NUL-padding
 * signal is unavailable. Measured against 73 adversarial negatives (latin1
 * prose, cp1252 byte soup, full-range soup, arithmetic sequences, UTF-8 in
 * twelve scripts, JSON, NUL noise, buffers of 1-512 bytes): the highest score any
 * of them reached at or above UTF16_MIN_BYTES was 0.250.
 */
const UTF16_MIN_SCORE = 0.6;

/**
 * Minimum gap between the two byte-order scores.
 *
 * The score decides *which* order, so a coin-flip must not be reported as a
 * decision. Every true UTF-16 document measured separates by at least 0.500.
 */
const UTF16_MIN_GAP = 0.25;

/**
 * Minimum fraction of distinct characters in the winning decode.
 *
 * Rejects the one negative that scores perfectly: NUL-injected ASCII. 64
 * alternating 0x41/0x00 bytes decode to 32 identical "A"s -- score 1.000 in one
 * order, 0.000 in the other, so score and gap both wave it through -- but the
 * distinct-character ratio is 0.031. Measured true UTF-16 minimum across nine
 * scripts: 0.400 (Arabic); the Thai sample sits at 0.833.
 */
const UTF16_MIN_DISTINCT = 0.15;

/**
 * Fraction of characters in a string that are distinct from each other.
 *
 * Not a text-quality heuristic: it counts distinct code points, so a document
 * in a script this module cannot classify still scores high. It exists to
 * separate "a document" from "one character repeated", which no byte-class
 * signal distinguishes.
 *
 * @param {string} text
 * @returns {number} in [0, 1]; 0 for empty input
 */
function distinctRatio(text) {
  const chars = [...String(text)];
  if (chars.length === 0) return 0;
  return new Set(chars).size / chars.length;
}

/**
 * Does a buffer start with these bytes?
 * @param {Buffer} buffer
 * @param {readonly number[]} bytes
 * @returns {boolean}
 */
function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Decode UTF-8 the strict way, rejecting overlong forms, surrogates and
 * out-of-range code points -- the same rules the WHATWG Encoding Standard
 * applies. A permissive decoder would accept text that merely happens to start
 * looking like UTF-8 and report a high confidence for a Latin-1 file.
 *
 * @param {Buffer} buffer
 * @param {number} start index to start at (after any BOM)
 * @returns {{ ok: boolean, error: string|null, codeUnits: number }}
 */
function validateUtf8(buffer, start = 0) {
  let i = start;
  let codeUnits = 0;
  while (i < buffer.length) {
    const b0 = buffer[i];
    let needed;
    let min;
    let cp;
    if (b0 <= 0x7f) {
      i++;
      codeUnits++;
      continue;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      needed = 1;
      min = 0x80;
      cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      needed = 2;
      min = 0x800;
      cp = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      needed = 3;
      min = 0x10000;
      cp = b0 & 0x07;
    } else {
      // 0x80-0xBF is a stray continuation byte; 0xC0/0xC1 are overlong leads;
      // 0xF5-0xFF cannot begin a valid sequence.
      return { ok: false, error: `invalid UTF-8 lead byte 0x${b0.toString(16)} at ${i}`, codeUnits };
    }

    // The sequence needs `needed` more bytes after the lead, so the last one
    // must exist at index i + needed.
    if (i + needed > buffer.length - 1) {
      return { ok: false, error: `truncated UTF-8 sequence at ${i}`, codeUnits };
    }
    for (let k = 1; k <= needed; k++) {
      const bx = buffer[i + k];
      if ((bx & 0xc0) !== 0x80) {
        return { ok: false, error: `invalid UTF-8 continuation byte at ${i + k}`, codeUnits };
      }
      cp = (cp << 6) | (bx & 0x3f);
    }
    if (cp < min) {
      return { ok: false, error: `overlong UTF-8 encoding at ${i}`, codeUnits };
    }
    if (cp >= 0xd800 && cp <= 0xdfff) {
      return { ok: false, error: `UTF-8 encoded surrogate at ${i}`, codeUnits };
    }
    if (cp > 0x10ffff) {
      return { ok: false, error: `UTF-8 code point out of range at ${i}`, codeUnits };
    }
    i += needed + 1;
    codeUnits++;
  }
  return { ok: true, error: null, codeUnits };
}

/**
 * Fraction of NUL bytes in the buffer. UTF-16 of ASCII or any non-Latin script
 * keeps a NUL in every other byte, so this separates UTF-16 from single-byte
 * encodings far more reliably than "does it decode" does.
 *
 * @param {Buffer} buffer
 * @returns {number}
 */
function nulRatio(buffer) {
  if (buffer.length === 0) return 0;
  let nul = 0;
  for (const byte of buffer) if (byte === 0x00) nul++;
  return nul / buffer.length;
}

/**
 * Fraction of bytes that are structural (NUL) or control characters, ignoring
 * anything at or above 0x80.
 *
 * The 0x80+ exclusion is essential, not a nicety. Every byte of a multi-byte UTF-8
 * sequence after the first is 0x80-0xBF; counting those as "control" made a
 * perfectly ordinary Russian or Japanese file look like 43% binary, because the
 * ratio was being measured in bytes on data whose natural unit is characters.
 * Text encodings put meaning in the high range. Only when we already know the
 * bytes are NOT a text encoding do we fall back to treating high bytes as
 * suspicious (see `binaryControlRatio`).
 *
 * @param {Buffer} buffer
 * @returns {number}
 */
function controlRatio(buffer) {
  if (buffer.length === 0) return 0;
  let control = 0;
  for (const byte of buffer) {
    if (byte >= 0x80) continue; // high bytes belong to a text encoding
    const isPrintableAscii =
      (byte >= 0x20 && byte <= 0x7e) ||
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      byte === 0x0c ||
      byte === 0x1b; // ESC, tolerated: ANSI colour codes are text-adjacent
    if (!isPrintableAscii) control++;
  }
  return control / buffer.length;
}

/**
 * Fraction of bytes that are neither printable ASCII nor whitespace nor
 * printable-ish high bytes -- used ONLY once a buffer has been ruled out as a
 * text encoding, to separate "binary" from "latin1".
 *
 * @param {Buffer} buffer
 * @returns {number}
 */
function binaryControlRatio(buffer) {
  if (buffer.length === 0) return 0;
  let odd = 0;
  for (const byte of buffer) {
    const printable = byte >= 0x20 && byte !== 0x7f;
    if (!printable) odd++;
  }
  return odd / buffer.length;
}

/**
 * Inspect a buffer and report which encoding it is in.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{
 *   encoding: string, bom: string|null, confidence: number,
 *   size: number, reason: string, nulRatio: number, controlRatio: number,
 *   utf8Valid: boolean
 * }}
 */
function detectFileEncoding(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const size = buffer.length;

  if (size === 0) {
    return Object.freeze({
      encoding: 'utf8',
      bom: null,
      confidence: 0,
      size: 0,
      reason: 'empty buffer: no evidence either way, assuming utf8',
      nulRatio: 0,
      controlRatio: 0,
      utf8Valid: false,
    });
  }

  const nul = nulRatio(buffer);
  const control = controlRatio(buffer);
  const binaryish = binaryControlRatio(buffer);

  // 1. A BOM is a declaration from whoever wrote the file. Trust it outright.
  for (const [bytes, name] of BOMS) {
    if (startsWith(buffer, bytes)) {
      return Object.freeze({
        encoding: name,
        bom: name,
        confidence: 1,
        size,
        reason: `byte-order mark for ${name} present`,
        nulRatio: nul,
        controlRatio: control,
        utf8Valid: name === 'utf8',
      });
    }
  }

  // 2. NUL-laden bytes are UTF-16 in some byte order. NUL parity is only a hint,
  //    and on ASCII text it is a misleading one: "Hi" in UTF-16LE is
  //    48 00 69 00 -- NULs on the ODD indices -- which the naive rule reads as
  //    big-endian. So the hint is used to shortlist the two orders and then each
  //    one is tested by whether decoding it produces plausible text. That test is
  //    what actually decides, and it gets ASCII right because UTF-16LE then
  //    yields "Hi" while UTF-16BE yields unassigned characters.
  // NULs clustered on one parity is the UTF-16 signature, whatever the overall
  // NUL fraction. The gate is therefore `nul > 0`, NOT a fixed byte fraction.
  //
  // It used to be `nul >= 0.05`, which contradicted this comment: for any script
  // whose UTF-16 code units are mostly >= U+0100 there is little or no NUL
  // padding at all, so the fraction has nothing to read and the file falls
  // through to "binary" and is decoded as latin1 garbage. Measured proportions of
  // zero bytes in a UTF-16 buffer: Russian 0.11, Hebrew 0.14, Greek 0.10, but
  // Arabic 0.038, Devanagari 0.038 and Thai 0.000 -- Devanagari has ONE zero
  // byte in thirteen code units. Those three are all real text and all were
  // being missed.
  //
  // A bare `nul > 0` is not enough: a binary file whose NULs happen to land on
  // one parity satisfies it (measured: two 512-byte arithmetic sequences at
  // nul=0.003 with clustering 1.0). So the padding arm keeps the 0.05 floor it
  // always had, and the NEW capability arrives as a separate arm below.
  const paritySplit = nulsByParity(buffer);
  const clustered =
    Math.max(paritySplit.even, paritySplit.odd) / Math.max(paritySplit.even + paritySplit.odd, 1);
  const padded = nul >= 0.05 && clustered >= 0.8;
  // The second arm exists for the scripts that have no padding to measure: a
  // document whose UTF-16 code units are all >= U+0100. It is consulted only
  // when the buffer is big enough for a score to mean anything, and it must then
  // pass on its own merits -- there is no parity to fall back on, so a weak
  // result declines to claim UTF-16 at all.
  const scorable = size >= UTF16_MIN_BYTES;
  if (padded || scorable) {
    const as = evaluateUtf16(buffer, 'utf16le');
    const bs = evaluateUtf16(buffer, 'utf16be');
    const gap = Math.abs(as.score - bs.score);
    const best = as.score >= bs.score ? as : bs;
    // Three conditions, all measured rather than guessed:
    //
    //   score >= 0.6  admits a real document. Measured: every true UTF-16 file
    //     scores 1.000 in its own order except an emoji sample at 0.719, while
    //     all 73 adversarial negatives (latin1 prose, cp1252 soup, full-range
    //     soup, arithmetic sequences, UTF-8 in twelve scripts, JSON, NUL noise,
    //     buffers of 1-512 bytes) reached at most 0.250 at or above
    //     UTF16_MIN_BYTES.
    //   gap  >= 0.25  the score must DECIDE the byte order. Every true UTF-16
    //     file measured separates by at least 0.500.
    //   distinctness  a decode made almost entirely of one repeated character is
    //     not a document. This is what stops NUL-injected ASCII from taking the
    //     new arm: 64 alternating 0x41/0x00 bytes decode to 32 identical "A"s
    //     with a score of 1.000 and a gap of 1.000, so score and gap alone both
    //     wave it through. Its distinct-character ratio is 0.031.
    //
    // Measured true UTF-16 distinctness minimum across nine scripts: 0.400
    // (Arabic). The threshold is well below that and far above 0.031.
    const distinct = distinctRatio(best.text);
    const scoreDecides =
      gap >= UTF16_MIN_GAP && best.score >= UTF16_MIN_SCORE && distinct >= UTF16_MIN_DISTINCT;
    const winnerEncoding = scoreDecides
      ? best.encoding
      : padded
        ? (paritySplit.odd >= paritySplit.even ? 'utf16le' : 'utf16be')
        : null;
    if (winnerEncoding === null) {
      // Indistinguishable from single-byte text: let the later steps classify it.
    } else {
      const decided = winnerEncoding === 'utf16le' ? as : bs;
      const other = winnerEncoding === 'utf16le' ? bs : as;
      const decisive = winnerEncoding === best.encoding;
      return Object.freeze({
        encoding: decided.encoding,
        bom: null,
        confidence: Number(
          (decisive ? Math.min(0.7 + decided.score * 0.3, 0.99) : 0.6).toFixed(4)
        ),
        size,
        reason:
          `${(nul * 100).toFixed(0)}% NUL bytes clustered on the ` +
          `${paritySplit.odd >= paritySplit.even ? 'odd' : 'even'} offsets; decoding as ` +
          `${decided.encoding} scores ${decided.score.toFixed(2)} vs ${other.score.toFixed(2)} ` +
          `for ${other.encoding}${scoreDecides ? '' : ' (tie, broken by NUL position)'}`,
        nulRatio: nul,
        controlRatio: control,
        utf8Valid: false,
      });
    }
  }

  // 3. Mostly non-printable bytes with no UTF-16 NUL structure: not text at all,
  //    so there is no text-encoding problem to report.
  if (binaryish > 0.3) {
    return Object.freeze({
      encoding: 'binary',
      bom: null,
      confidence: Number(Math.min(0.5 + (binaryish - 0.3) * 1.4, 0.99).toFixed(4)),
      size,
      reason: `${(binaryish * 100).toFixed(0)}% non-printable bytes: binary, not text`,
      nulRatio: nul,
      controlRatio: control,
      utf8Valid: false,
    });
  }

  // 4. Well-formed UTF-8 is UTF-8. High confidence, but not certain: a Latin-1
  //    file that happens to use only ASCII-compatible bytes validates too.
  const validated = validateUtf8(buffer, 0);
  if (validated.ok) {
    const nonAscii = countNonAscii(buffer);
    const confidence =
      nonAscii === 0 ? 0.7 : Math.min(0.9 + nonAscii / buffer.length * 0.1, 0.99);
    return Object.freeze({
      encoding: 'utf8',
      bom: null,
      confidence: Number(confidence.toFixed(4)),
      size,
      reason:
        nonAscii === 0
          ? 'valid UTF-8, but pure ASCII: could be latin1 (indistinguishable)'
          : 'decodes as well-formed UTF-8 including non-ASCII bytes',
      nulRatio: nul,
      controlRatio: control,
      utf8Valid: true,
    });
  }

  // 5. Valid single-byte text that is not valid UTF-8. Almost certainly Latin-1
  //    or a Windows codepage; latin1 is named because it is total over all byte
  //    values, so it is the only one of them that cannot fail to decode.
  if (binaryish <= 0.3) {
    return Object.freeze({
      encoding: 'latin1',
      bom: null,
      confidence: 0.75,
      size,
      reason: `not valid UTF-8 (${validated.error}) but mostly printable: latin1`,
      nulRatio: nul,
      controlRatio: control,
      utf8Valid: false,
    });
  }

  return Object.freeze({
    encoding: 'binary',
    bom: null,
    confidence: 0.5,
    size,
    reason: 'no encoding fits',
    nulRatio: nul,
    controlRatio: control,
    utf8Valid: false,
  });
}

/**
 * Count NUL bytes on even and odd byte offsets.
 *
 * UTF-16 of text whose code units fit in one byte (ASCII, and most Western
 * European) leaves NUL padding in one fixed position, so the NULs cluster on one
 * parity. This is the structural signal that distinguishes UTF-16 from a binary
 * file that happens to contain NULs scattered evenly.
 *
 * @param {Buffer} buffer
 * @returns {{ even: number, odd: number }}
 */
function nulsByParity(buffer) {
  let even = 0;
  let odd = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0x00) continue;
    if (i % 2 === 0) even++;
    else odd++;
  }
  return { even, odd };
}

/**
 * Decode a buffer as UTF-16 in one byte order and score how plausible the result is
 * as text.
 *
 * This is the test that actually distinguishes the two byte orders. Reading
 * UTF-16LE text in the wrong order yields lone surrogates and unassigned code
 * points, which are not things text contains; reading it in the right order yields
 * letters, spaces and punctuation. Scoring the decoded output therefore separates
 * the cases that NUL parity alone gets wrong.
 *
 * @param {Buffer} buffer
 * @param {'utf16le'|'utf16be'} encoding byte order to try
 * @returns {{ encoding: string, score: number, text: string }}
 */
function evaluateUtf16(buffer, encoding) {
  let text;
  try {
    text = encoding === 'utf16le' ? buffer.toString('utf16le') : swapPairs(buffer).toString('utf16le');
  } catch {
    return { encoding, score: 0, text: '' };
  }
  const chars = [...text];
  if (chars.length === 0) return { encoding, score: 0, text };

  // Surrogates and unassigned points never appear in real text. Reading UTF-16 in
  // the wrong byte order also produces code points in the high BMP and beyond --
  // "Hi" read as big-endian is U+4800 U+6900, CJK extension A, which is assigned
  // and therefore "printable", but is overwhelmingly unlikely in a document that
  // also contains ASCII. Both are treated as evidence against that byte order.
  let plausible = 0;
  let implausible = 0;
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    const isSurrogate = cp >= 0xd800 && cp <= 0xdfff;
    const isUnassigned = (cp >= 0xfdd0 && cp <= 0xfdef) || cp === 0xfffe || cp === 0xffff;
    const isWhitespace = cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20;
    if (isSurrogate || isUnassigned) {
      implausible++;
      continue;
    }
    if (isWhitespace) {
      plausible++; // whitespace is as much evidence as a letter
      continue;
    }
    if (cp >= 0x21 && cp <= 0x7e) {
      plausible++; // printable ASCII
      continue;
    }
    if (cp >= 0xa0 && cp <= 0x2fff) {
      plausible++; // Latin-1 supplement through CJK punctuation: all common
      continue;
    }
    // Everything above U+2FFF is where the wrong byte order hides: reading
    // little-endian text as big-endian produces CJK Extension A
    // (U+3400-U+4DBF, "䠀攀氀氀") and Hangul syllables, both of which are
    // ASSIGNED and therefore look printable, yet are vanishingly rare in the
    // documents this tool sees. Counting them as plausible made both byte orders
    // score 1.0 and left the decision to a NUL-parity tie-break. They are counted
    // as implausible instead, which makes the byte-order decision a real test.
    implausible++;
  }
  const score = Math.max(0, plausible / chars.length - (implausible / chars.length) * 0.5);
  return { encoding, score: Number(score.toFixed(6)), text };
}

/**
 * Count bytes >= 0x80.
 * @param {Buffer} buffer
 * @returns {number}
 */
function countNonAscii(buffer) {
  let n = 0;
  for (const byte of buffer) if (byte >= 0x80) n++;
  return n;
}

/**
 * Decode a buffer according to a detected encoding.
 *
 * @param {Buffer|Uint8Array} input
 * @param {string} [encoding] defaults to the detected encoding
 * @returns {string}
 */
function decodeFile(input, encoding) {
  let buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const name = encoding || detectFileEncoding(buffer).encoding;

  // A BOM is metadata, not content. Leaving it in means every repaired string
  // starts with a stray U+FEFF, which then shows up in every diff.
  for (const [bytes, bomName] of BOMS) {
    if (name === bomName && startsWith(buffer, bytes)) {
      buffer = buffer.subarray(bytes.length);
      break;
    }
  }

  switch (name) {
    case 'utf16le':
      return buffer.toString('utf16le');
    case 'utf16be':
      return swapPairs(buffer).toString('utf16le');
    case 'latin1':
      return buffer.toString('latin1');
    case 'binary':
      return buffer.toString('latin1');
    case 'utf8':
    default:
      return buffer.toString('utf8');
  }
}

/**
 * Swap each pair of bytes, turning big-endian into little-endian so Node's
 * utf16le decoder can read it.
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
function swapPairs(buffer) {
  const out = Buffer.from(buffer);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const tmp = out[i];
    out[i] = out[i + 1];
    out[i + 1] = tmp;
  }
  return out;
}

module.exports = Object.freeze({
  BOMS,
  ENCODINGS,
  UTF16_MIN_BYTES,
  UTF16_MIN_DISTINCT,
  UTF16_MIN_GAP,
  UTF16_MIN_SCORE,
  binaryControlRatio,
  controlRatio,
  distinctRatio,
  evaluateUtf16,
  decodeFile,
  detectFileEncoding,
  nulsByParity,
  nulRatio,
  swapPairs,
  validateUtf8,
});