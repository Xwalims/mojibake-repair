'use strict';

// Single-byte codecs and the lossy-latin1 bridge used to simulate the classic
// "encode as one charset, decode as another" accident.
//
// Encoding failure is modelled the way real pipelines hit it: either with an
// exception (`strict`) or by substituting U+FFFD (`lossy`). Nothing here throws
// by default, so a repair attempt over hostile bytes returns a failed candidate
// instead of taking the process down.

const { CP1251, CP1252, REVERSE_CP1251, REVERSE_CP1252 } = require('./tables.js');

const REPLACEMENT = '�';

/** Byte -> code point tables keyed by canonical codec name. */
const DECODE_TABLES = Object.freeze({
  latin1: null, // identity below; spelled out for symmetry
  'iso-8859-1': null,
  cp1251: CP1251,
  cp1252: CP1252,
});

/** Code point -> byte maps keyed by canonical codec name. */
const ENCODE_TABLES = Object.freeze({
  latin1: null,
  'iso-8859-1': null,
  cp1251: REVERSE_CP1251,
  cp1252: REVERSE_CP1252,
});

/** Every codec name this module accepts, canonical form first. */
const CODECS = Object.freeze(['latin1', 'cp1251', 'cp1252', 'utf8']);

/**
 * Normalise user input to a canonical codec name.
 * @param {string} name
 * @returns {string} one of CODECS
 */
function normalizeCodec(name) {
  const key = String(name).toLowerCase().replace(/[_\s]/g, '-');
  switch (key) {
    case 'latin1':
    case 'latin-1':
    case 'iso-8859-1':
    case 'iso8859-1':
    case 'binary':
      return 'latin1';
    case 'cp1251':
    case 'windows-1251':
    case 'win1251':
    case '1251':
      return 'cp1251';
    case 'cp1252':
    case 'windows-1252':
    case 'win1252':
    case '1252':
      return 'cp1252';
    case 'utf8':
    case 'utf-8':
    case 'unicode-1-1-utf-8':
      return 'utf8';
    default:
      throw new RangeError(
        `unknown encoding ${JSON.stringify(name)}; expected one of: ${CODECS.join(', ')}`
      );
  }
}

/**
 * Decode a Buffer with a single-byte codec.
 *
 * latin1 is ISO-8859-1: byte n -> U+00FF. It is total over all 256 bytes.
 *
 * @param {Buffer} buffer
 * @param {string} name canonical codec name
 * @param {{ strict?: boolean }} [options] strict: throw on an undefined byte
 * @returns {string}
 */
function decode(buffer, name, options = {}) {
  const codec = normalizeCodec(name);
  if (codec === 'utf8') {
    // Buffer's own utf8 decoder; non-fatal, emits U+FFFD for bad bytes.
    return buffer.toString('utf8');
  }
  if (codec === 'latin1') {
    return buffer.toString('latin1');
  }
  const table = DECODE_TABLES[codec];
  let out = '';
  for (const byte of buffer) {
    const cp = table[byte];
    if (cp === null || cp === undefined) {
      if (options.strict) {
        throw new RangeError(
          `byte 0x${byte.toString(16)} is not defined in ${codec}`
        );
      }
      out += REPLACEMENT;
      continue;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/**
 * Encode a string with a single-byte codec.
 *
 * Code points the codec cannot represent become U+FFFD (`lossy`, the default)
 * or raise (`strict`). Control characters pass through unchanged for every
 * codec, which matches TextDecoder's behaviour and keeps round trips honest.
 *
 * @param {string} text
 * @param {string} name canonical codec name
 * @param {{ strict?: boolean }} [options]
 * @returns {Buffer}
 */
function encode(text, name, options = {}) {
  const codec = normalizeCodec(name);
  if (codec === 'utf8') {
    return Buffer.from(text, 'utf8');
  }
  const bytes = [];
  for (const char of text) {
    const cp = char.codePointAt(0);
    let byte;
    if (codec === 'latin1') {
      byte = cp <= 0xff ? cp : null;
    } else {
      byte = ENCODE_TABLES[codec].get(cp);
    }
    if (byte === undefined || byte === null) {
      if (options.strict) {
        throw new RangeError(
          `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ` +
            `${JSON.stringify(char)} is not representable in ${codec}`
        );
      }
      byte = 0x3f; // '?' -- what most lossy encoders substitute
    }
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Re-encode text as UTF-8 bytes read back through a single-byte codec. This is
 * the operation that *creates* mojibake, so it is the primitive every repair
 * candidate is built from.
 *
 * @param {string} text
 * @param {string} name codec to pass through
 * @returns {string}
 */
function mojibake(text, name) {
  return decode(encode(text, 'utf8'), name);
}

/**
 * The inverse: read text as UTF-8 bytes misdecoded through a single-byte codec.
 *
 * @param {string} text broken text
 * @param {string} name codec the text was (wrongly) decoded with
 * @param {{ strict?: boolean }} [options]
 * @returns {string}
 */
function unmangle(text, name, options = {}) {
  return decode(encode(text, name, options), 'utf8');
}

module.exports = Object.freeze({
  CODECS,
  REPLACEMENT,
  decode,
  encode,
  mojibake,
  unmangle,
  normalizeCodec,
});