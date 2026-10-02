'use strict';

// Candidate repairs.
//
// A repair is a hypothesis about *which mistake was made*, not a single blind
// "latin1 round trip". The same byte sequence can legitimately come from
// different original encodings, so every plausible hypothesis is generated here,
// scored independently in score.js, and ranked.
//
// Every generation path is TOTAL: if a step throws (an undecodable byte, a code
// point the codec cannot represent, a hostile surrogate), the failure is recorded
// on the candidate and generation continues. Nothing in this module throws for
// bad input data, because a repair tool that crashes on hostile bytes is useless
// exactly when it is needed most.

const { decode, encode, normalizeCodec } = require('./codecs.js');

/**
 * The repair strategies, in the fixed order they are generated. Order is part of
 * the contract: it is the deterministic tie-break when two candidates score
 * identically, so the same input always ranks the same way.
 *
 * Each entry reads:
 *   id          stable identifier, reported by the CLI and the result object
 *   assumed     what the broken text is assumed to have been decoded with
 *   fix         the operation that undoes it
 *   note        why this hypothesis is plausible
 */
const STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'utf8-as-latin1',
    assumed: 'latin1',
    label: 'UTF-8 bytes misdecoded as ISO-8859-1',
    note:
      'The classic case: UTF-8 text read through latin1 by a mislabelled page, ' +
      'HTTP header or subprocess pipe. Each 2-byte UTF-8 sequence became 2 ' +
      'Latin-1 characters, so the repair re-encodes to latin1 and decodes as UTF-8.',
  }),
  Object.freeze({
    id: 'utf8-as-cp1252',
    assumed: 'cp1252',
    label: 'UTF-8 bytes misdecoded as windows-1252',
    note:
      'Identical to utf8-as-latin1 except that 0x80-0x9F decode to typographic ' +
      'punctuation (€, curly quotes, ellipsis). Right for Windows-produced text; ' +
      'only distinguishable from latin1 when those bytes actually occur.',
  }),
  Object.freeze({
    id: 'utf8-as-cp1251',
    assumed: 'cp1251',
    label: 'UTF-8 bytes misdecoded as windows-1251',
    note:
      'Russian UTF-8 read through windows-1251. Produces clean-looking Cyrillic ' +
      'with no byte-pairing at all, which is why detection needs its own signal ' +
      'and why this candidate is generated even when pairing looks clean.',
  }),
  Object.freeze({
    id: 'latin1-as-utf8',
    assumed: 'utf8',
    label: 'ISO-8859-1 bytes misdecoded as UTF-8',
    note:
      'The reverse accident: 8-bit text decoded as UTF-8. Legitimate text usually ' +
      'yields U+FFFD where a byte was not valid UTF-8; a byte-identical Latin-1 ' +
      'reading is offered as a lossless alternative.',
  }),
  Object.freeze({
    id: 'cp1251-as-utf8',
    assumed: 'utf8',
    label: 'windows-1251 bytes misdecoded as UTF-8',
    note:
      'Cyrillic 8-bit text decoded as UTF-8. Windows-1251 uses high bytes in ' +
      'ranges that are never valid UTF-8, so this typically produces U+FFFD and ' +
      'is beaten by the lossless Latin-1 reading; it can still win when the text ' +
      'is mostly ASCII with a few high bytes.',
  }),
  Object.freeze({
    id: 'cp1252-as-utf8',
    assumed: 'utf8',
    label: 'windows-1252 bytes misdecoded as UTF-8',
    note:
      'Western European 8-bit text decoded as UTF-8. Same shape as cp1251-as-utf8; ' +
      'the two are distinguishable only by which high bytes the text contains.',
  }),
]);

/** Look-up of a strategy by id. */
const STRATEGY_BY_ID = new Map(STRATEGIES.map((s) => [s.id, s]));

/** Every strategy id, for documentation and tests. */
const STRATEGY_IDS = Object.freeze(STRATEGIES.map((s) => s.id));

/**
 * Strategies that make sense for a given input. `latin1` round trips are only
 * attempted when the text can contain non-ASCII bytes at all -- attempting them
 * on pure ASCII produces the identity transformation, which is never useful and
 * would pollute the ranking with a no-op.
 *
 * @param {string} text
 * @returns {readonly object[]}
 */
function applicableStrategies(text) {
  const hasNonAscii = [...String(text)].some((ch) => ch.codePointAt(0) >= 0x80);
  if (!hasNonAscii) return [];
  return STRATEGIES;
}

/**
 * Run one strategy.
 *
 * Never throws: every failure mode is caught and recorded as `{ ok: false, error }`
 * so the caller can report why a hypothesis was rejected instead of dying.
 *
 * @param {object} strategy
 * @param {string} text
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function attempt(strategy, text) {
  try {
    const assumed = normalizeCodec(strategy.assumed);
    // Re-read the broken text's code points as single bytes, then decode those
    // bytes as UTF-8. For assumed === 'utf8' the broken text came from bytes
    // that are not valid UTF-8, so they are read back through latin1 (total over
    // all 256 byte values) before the strict UTF-8 decode, which is where U+FFFD
    // for unrecoverable bytes comes from.
    const bytes = encode(text, assumed === 'utf8' ? 'latin1' : assumed);
    const value = decode(bytes, 'utf8');
    if (typeof value !== 'string') {
      return { ok: false, error: 'decode did not produce a string' };
    }
    return { ok: true, value };
  } catch (error) {
    // An undecodable byte, an unmappable code point, a lone surrogate: all of
    // these are data problems, not programming errors. Record and move on.
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/**
 * Generate every candidate repair for a piece of text.
 *
 * Failed attempts are returned too, with `value: null` and an `error`, so a
 * caller can show *why* the repair it wanted was impossible. They are never
 * scored, because there is nothing to score.
 *
 * @param {string} text
 * @param {{ strategies?: readonly string[] }} [options] restrict to these ids
 * @returns {ReadonlyArray<{
 *   id: string, label: string, assumed: string, note: string,
 *   value: string|null, error: string|null, changed: boolean
 * }>}
 */
function generateCandidates(text, options = {}) {
  const source = String(text);
  let pool = applicableStrategies(source);
  if (options.strategies) {
    const wanted = new Set(options.strategies);
    pool = pool.filter((s) => wanted.has(s.id));
  }

  const out = [];
  for (const strategy of pool) {
    const result = attempt(strategy, source);
    out.push(
      Object.freeze({
        id: strategy.id,
        label: strategy.label,
        assumed: strategy.assumed,
        note: strategy.note,
        value: result.ok ? result.value : null,
        error: result.ok ? null : result.error,
        // "changed" is informational here; the scorer decides what wins.
        changed: result.ok ? result.value !== source : false,
      })
    );
  }
  return Object.freeze(out);
}

module.exports = Object.freeze({
  STRATEGIES,
  STRATEGY_IDS,
  STRATEGY_BY_ID,
  applicableStrategies,
  attempt,
  generateCandidates,
});