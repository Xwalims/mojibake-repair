'use strict';

// repair() -- the public entry point.
//
// The contract, in order of importance:
//
//  1. NEVER LOSE DATA. The original text is always recoverable from the result
//     object, whether or not a repair happens. `result.original` is always the
//     exact input string.
//
//  2. NEVER MANGLE CORRECT TEXT. If no candidate beats the confidence threshold,
//     the ORIGINAL string is returned byte-identical with `confident: false`.
//     This is the behaviour that separates a repair tool from a text mangler,
//     and it is the reason the threshold exists at all. "Looks like it might be
//     broken" is not grounds to change text.
//
//  3. SAY WHAT IT DID. Every candidate tried is returned with its score and the
//     reason it won or lost, so a decision can be inspected rather than trusted.
//
//  4. BE DETERMINISTIC. Same input, same output, same ranking, every time.

const { generateCandidates, STRATEGY_BY_ID, STRATEGY_IDS } = require('./candidates.js');
const { looksMojibake, THRESHOLDS } = require('./detect.js');
const { DEFAULT_MIN_SCORE, rankCandidates } = require('./score.js');

/**
 * Every option with its default, in one frozen object. Defaults live here and
 * nowhere else.
 *
 * minScore        confidence threshold a candidate must beat to be used
 * encoding        force one hypothesis instead of considering all of them;
 *                 'auto' (default) means try all and rank them
 * detectOnly      report the verdict but never change the text
 * strategies      restrict the candidate pool by id
 * suspectScore    detection score at or above which text is considered broken
 */
const DEFAULTS = Object.freeze({
  minScore: DEFAULT_MIN_SCORE,
  encoding: 'auto',
  detectOnly: false,
  strategies: null,
  suspectScore: THRESHOLDS.suspect,
});

/** Valid values for the `encoding` option. */
const ENCODINGS = Object.freeze(['auto', 'utf8', 'latin1', 'cp1251', 'cp1252']);

/**
 * Repair a piece of text.
 *
 * @param {string} text the possibly-broken text
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{
 *   value: string,
 *   original: string,
 *   changed: boolean,
 *   confident: boolean,
 *   best: object|null,
 *   encoding: string|null,
 *   detection: object,
 *   candidates: ReadonlyArray<object>,
 *   reason: string,
 *   options: typeof DEFAULTS
 * }}
 */
function repair(text, options = {}) {
  const original = typeof text === 'string' ? text : String(text);
  const opts = Object.assign({}, DEFAULTS, options);

  // Validate the encoding option up front so a typo is a loud error, not a
  // silently ignored preference.
  if (!ENCODINGS.includes(opts.encoding)) {
    throw new RangeError(
      `unknown encoding ${JSON.stringify(opts.encoding)}; expected one of: ${ENCODINGS.join(', ')}`
    );
  }
  if (opts.strategies !== null) {
    for (const id of opts.strategies) {
      if (!STRATEGY_IDS.includes(id)) {
        throw new RangeError(
          `unknown strategy ${JSON.stringify(id)}; expected one of: ${STRATEGY_IDS.join(', ')}`
        );
      }
    }
  }

  const detection = looksMojibake(original);
  const considered = detection.score >= opts.suspectScore;

  // Build the candidate pool. A forced encoding restricts it to that one
  // hypothesis; 'auto' considers all of them.
  let pool = opts.strategies;
  if (opts.encoding !== 'auto') {
    const forced = STRATEGY_IDS.filter((id) => strategyAssumes(id, opts.encoding));
    pool = pool ? pool.filter((id) => forced.includes(id)) : forced;
  }

  const candidates = rankCandidates(
    generateCandidates(original, pool ? { strategies: pool } : {}),
    original,
    { minScore: opts.minScore }
  );

  // Nothing was broken, so nothing to do. Return the input untouched.
  if (!considered) {
    return finish(original, original, false, false, null, candidates, detection, opts, {
      detection,
      reason:
        detection.signals.length === 0
          ? 'no mojibake signature detected; text returned unchanged'
          : `detection score ${detection.score} below threshold ${opts.suspectScore}; text returned unchanged`,
    });
  }

  // --detect-only: report, change nothing.
  if (opts.detectOnly) {
    return finish(original, original, false, false, null, candidates, detection, opts, {
      detection,
      reason: `detected broken encoding (score ${detection.score}); --detect-only, text unchanged`,
    });
  }

  const winner = pickWinner(candidates, opts);
  if (!winner) {
    // The most important branch in this file: no candidate is trustworthy, so
    // the original text is returned byte-identical.
    return finish(original, original, false, false, null, candidates, detection, opts, {
      detection,
      reason: bestFailureReason(candidates, opts),
    });
  }

  // A repair that improves on a PREVIOUSLY broken text may legitimately end with
  // a few U+FFFD, because some information was already lost before this tool saw
  // the input. Russian broken through windows-1251 contains "Ã‡a" for "Ça": the
  // byte 0x87 is undefined in windows-1252, so only the latin1 hypothesis can
  // round-trip it, and the latin1 hypothesis is the one that emits U+FFFD. Refusing
  // both would leave the document unrepairable forever.
  //
  // The rule is therefore RELATIVE: a candidate is disqualified for losing data
  // only when it has MORE replacement characters than the input it was repairing.
  // When the input is undamaged the two counts are equal at worst, so this is
  // never looser than the original absolute rule.
  const introducedFffd = countFffd(winner.value) - countFffd(original);
  const acceptable = introducedFffd <= 0;

  if (!acceptable) {
    return finish(original, original, false, false, null, candidates, detection, opts, {
      detection,
      reason:
        `best candidate ${winner.id} scored ${winner.score.toFixed(3)} but would ` +
        `introduce ${introducedFffd} replacement char(s) and lose data; returned unchanged`,
    });
  }

  return finish(
    original,
    winner.value,
    true,
    true,
    winner,
    candidates,
    detection,
    opts,
    {
      detection,
      reason:
        `repaired as ${winner.assumed}: score ${winner.score.toFixed(3)}` +
        (introducedFffd === 0 ? '' : ` (${introducedFffd} pre-existing damage retained)`),
    }
  );
}

/**
 * Count U+FFFD occurrences.
 * @param {string} text
 * @returns {number}
 */
function countFffd(text) {
  let n = 0;
  for (const ch of text) if (ch.codePointAt(0) === 0xfffd) n++;
  return n;
}

/**
 * The best candidate that beat the threshold and would not lose data.
 *
 * `eligible` (no U+FFFD at all) is checked first as a preference, not a filter: a
 * candidate that is perfectly lossless is always better than one that carries
 * residual damage. Candidates that are lossy are still considered here and
 * filtered by the RELATIVE test in repair(), because a lossy repair of
 * already-lossy text can still be a large improvement.
 *
 * @param {ReadonlyArray<object>} candidates ranked, best first
 * @param {typeof DEFAULTS} opts
 * @returns {object|null}
 */
function pickWinner(candidates, opts) {
  const usable = candidates.filter(
    (c) => c.eligible && c.score >= opts.minScore && c.changed
  );
  if (usable.length > 0) return usable[0];

  // Fall back to a lossy candidate only if nothing lossless qualifies. Whether it
  // is actually acceptable is decided by the relative U+FFFD check in repair().
  for (const candidate of candidates) {
    if (candidate.value === null) continue;
    if (candidate.score < opts.minScore) continue;
    if (!candidate.changed) continue;
    return candidate;
  }
  return null;
}

/**
 * Whether a strategy tests the hypothesis "the text was misdecoded as `encoding`".
 *
 * Each strategy names the codec it believes was used for the bad decode, so
 * forcing an encoding reduces the pool to the strategies that name it. This is
 * deliberately literal: `--encoding cp1252` means "assume the misdecoding was
 * cp1252", which is exactly one hypothesis, not a family of related ones.
 *
 * @param {string} id strategy id
 * @param {string} encoding user-facing encoding
 * @returns {boolean}
 */
function strategyAssumes(id, encoding) {
  const strategy = STRATEGY_BY_ID.get(id);
  return Boolean(strategy) && strategy.assumed === encoding;
}

/**
 * Explain, in one sentence, why nothing was repaired. Picks the most informative
 * failure across the candidate pool.
 *
 * @param {ReadonlyArray<object>} candidates
 * @param {typeof DEFAULTS} opts
 * @returns {string}
 */
function bestFailureReason(candidates, opts) {
  const usable = candidates.filter((c) => c.value !== null);
  if (usable.length === 0) {
    return 'no candidate could be generated for this text; returned unchanged';
  }
  const top = usable[0];
  if (!top.eligible) {
    return (
      `best candidate (${top.id}, score ${top.score.toFixed(3)}) introduced ` +
      `${top.parts.replacementChars} replacement chars and would lose data; returned unchanged`
    );
  }
  if (!top.changed) {
    return `best candidate (${top.id}) was the identity transform; returned unchanged`;
  }
  return (
    `best candidate ${top.id} scored ${top.score.toFixed(3)}, below the ` +
    `confidence threshold ${opts.minScore}; returned unchanged`
  );
}

/**
 * Assemble the frozen result object. Every field is present in every branch so
 * callers never have to probe for undefined.
 */
function finish(original, value, changed, confident, best, candidates, detection, opts, extra) {
  return Object.freeze({
    value,
    original,
    changed,
    confident,
    best: best || null,
    encoding: best ? best.assumed : null,
    detection: Object.freeze({
      broken: detection.broken,
      score: detection.score,
      signals: detection.signals,
      reason: detection.reason,
    }),
    candidates: Object.freeze(candidates),
    reason: extra.reason,
    options: Object.freeze(Object.assign({}, DEFAULTS, opts)),
  });
}

/**
 * Detect only, without repairing. A thin wrapper that shares repair()'s parsing so
 * there is exactly one definition of "is this broken".
 *
 * @param {string} text
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {object}
 */
function detect(text, options = {}) {
  return repair(text, Object.assign({}, options, { detectOnly: true }));
}

module.exports = Object.freeze({
  DEFAULTS,
  ENCODINGS,
  STRATEGY_IDS,
  detect,
  repair,
});