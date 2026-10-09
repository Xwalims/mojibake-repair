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
const { encode } = require('./codecs.js');
const { splitLines, groupSegments, mergeAdjacent, absorbUnchanged } = require('./segments.js');

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

  // U+003F substitution is a different kind of loss and gets an ABSOLUTE veto,
  // here as well as in the scorer. `score.js` floors any substituting candidate
  // at 0.000, which keeps it out of the pool at the default minScore of 0.6 --
  // but `--min-score 0` is a documented flag, and pickWinner()'s lossy fallback
  // ignores `eligible` entirely. Without a check here,
  //
  //   mojibake --repair --encoding cp1251 --min-score 0
  //
  // returned "e????g ????P??e??h??7K??Cg_x??" for a 21-character document and
  // reported success, having destroyed 18 of the 30 input code points with zero
  // U+FFFD to show for it. The scorer alone is not a veto; the winner has to be
  // checked here, where refusing is still an option.
  //
  // Relative would be wrong, as documented in the README: "how many rows?" is
  // ordinary text, so comparing counts cannot tell a real question mark from one
  // the codec manufactured, and the returned value carries no trace of which was
  // which.
  const substituted = Number.isInteger(winner.substitutedChars) ? winner.substitutedChars : 0;
  const lostSubstitutions = substituted > 0;

  if (introducedFffd > 0 || lostSubstitutions) {
    return finish(original, original, false, false, null, candidates, detection, opts, {
      detection,
      reason: bestFailureReason(candidates, opts, {
        winner,
        introducedFffd,
        substituted,
      }),
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
 * Whether a segment may adopt the codec the unit repair chose.
 *
 * The question this answers is "does the unit repair contradict anything the
 * segment's own lines actually decided?" -- and `seg.id` is the wrong thing to
 * ask it with. By the time a segment reaches here its id may be a label that
 * `absorbUnchanged()` invented for a block of undecided lines, or one
 * `mergeAdjacent()` stitched on. Those are bookkeeping, not evidence, and
 * comparing a codec name against them throws away a correct repair.
 *
 * It did exactly that. A block of French broken through cp1252 whose leading
 * lines were too short to detect on their own had its id inherited from the one
 * line that was detected -- `latin1`, the tie-break winner among two codecs that
 * disagree only across 0x80-0x9F. The unit repair over the joined block
 * correctly named `cp1252` and produced the right text; the name check rejected
 * it, and the fallback then kept only the lines whose own id matched, so the
 * whole segment came back broken.
 *
 * So the evidence is taken from the lines themselves: for every line that was
 * DECIDED on its own, the unit codec must either be the same or produce the same
 * bytes for that line. Undecided lines carry no evidence and do not object.
 * Byte-equality is the right test rather than name-equality because the two
 * Western codecs really are the same codec on most text -- when a line contains
 * no C1-range character they cannot disagree, and the per-line result stands
 * whichever name is used.
 *
 * When a decided line DOES contradict the unit repair -- genuinely different
 * codecs, different bytes for that line -- the unit repair is not allowed to
 * override it, and the caller keeps the per-line results instead.
 *
 * @param {ReadonlyArray<{id: string|null}>} lines the segment's lines
 * @param {string|null} unitEncoding codec the unit repair chose
 * @returns {boolean}
 */
function agreesWithLines(lines, unitEncoding) {
  if (unitEncoding === null) return false;
  for (const line of lines) {
    if (line.id === null) continue; // undecided: no evidence either way
    if (line.id === unitEncoding) continue;
    if (!sameBytesFor(line.content, line.id, unitEncoding)) return false;
  }
  return true;
}

/**
 * Whether two codecs encode this text to identical bytes.
 *
 * @param {string} text
 * @param {string} a canonical codec name
 * @param {string} b canonical codec name
 * @returns {boolean}
 */
function sameBytesFor(text, a, b) {
  try {
    return encode(text, a).equals(encode(text, b));
  } catch {
    return false;
  }
}

/**
 * Explain, in one sentence, why nothing was repaired. Picks the most informative
 * failure across the candidate pool.
 *
 * `veto` is supplied when a candidate WAS selected and then refused by the
 * data-loss rules, so the message names the actual rule that fired. Without it
 * the reason is inferred from the top of the pool, which is misleading when the
 * pool was narrowed (`--encoding`) and the top of it is the very candidate that
 * was just refused: that produced "introduced 0 replacement chars and would lose
 * data" for a refusal that had nothing to do with replacement characters.
 *
 * @param {ReadonlyArray<object>} candidates
 * @param {typeof DEFAULTS} opts
 * @param {{winner: object, introducedFffd: number, substituted: number}} [veto]
 * @returns {string}
 */
function bestFailureReason(candidates, opts, veto) {
  const usable = candidates.filter((c) => c.value !== null);
  if (usable.length === 0) {
    return 'no candidate could be generated for this text; returned unchanged';
  }

  if (veto) {
    const { winner, introducedFffd, substituted } = veto;
    const losses = [];
    if (introducedFffd > 0) losses.push(`${introducedFffd} replacement char(s)`);
    if (substituted > 0) {
      losses.push(`${substituted} character(s) its codec cannot represent, substituted with '?'`);
    }
    return (
      `best candidate ${winner.id} scored ${winner.score.toFixed(3)} but would lose data: ` +
      `${losses.join(' and ')}; returned unchanged`
    );
  }

  const top = usable[0];
  if (!top.eligible) {
    const losses = [];
    if (top.parts.replacementChars) losses.push(`${top.parts.replacementChars} replacement chars`);
    if (top.substitutedChars) {
      losses.push(`${top.substitutedChars} substituted chars`);
    }
    return (
      `best candidate (${top.id}, score ${top.score.toFixed(3)}) lost data: ` +
      `${losses.join(' and ')}; returned unchanged`
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

/**
 * Repair a document whose lines broke through DIFFERENT codecs.
 *
 * `repair()` refuses such input and returns it untouched, which is correct: a
 * single global hypothesis always destroys at least one part. But each line is
 * independently repairable, and refusing the whole document throws away real
 * data — the usual case being a French line served as cp1252 beside a Russian
 * line served as cp1251.
 *
 * This decides per segment. Each run of lines gets its own winning codec, judged
 * on that run alone, and a segment is only rewritten when its own repair is
 * confident. Segments are grouped AFTER scoring, so a document alternating every
 * line still collapses to two segments instead of one per line. A segment that
 * would change nothing (pure ASCII breaks identically through every codec) adopts
 * its neighbour's codec rather than fragmenting the document.
 *
 * The per-line contract of `repair()` is preserved: a segment that cannot be
 * repaired confidently keeps its original bytes, so the worst case is the input
 * unchanged — never worse.
 *
 * @param {string} text
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{
 *   value: string,
 *   original: string,
 *   changed: boolean,
 *   segments: ReadonlyArray<{encoding: string|null, lines: number, changed: boolean, reason: string}>,
 *   repairedSegments: number,
 *   refusedSegments: number,
 *   reason: string
 * }}
 */
function repairMixed(text, options = {}) {
  const original = typeof text === 'string' ? text : String(text);
  // detectOnly is honoured, NOT overridden. The per-segment decision needs the
  // real repair to know which codec won each segment, but --detect-only must
  // mean "decide and report, change nothing" -- which is why the segments are
  // still computed and then discarded below rather than the option being forced
  // off. Forcing it off (as an earlier draft did) made `--mixed --detect-only
  // -o FILE` write repaired text while the report claimed nothing was changed.
  const detectOnly = Boolean(options.detectOnly);
  const opts = Object.assign({}, DEFAULTS, options, { detectOnly: false });

  const lines = splitLines(original);
  if (lines.length === 0) {
    return Object.freeze({
      value: original,
      original,
      changed: false,
      segments: Object.freeze([]),
      repairedSegments: 0,
      refusedSegments: 0,
      reason: 'empty input; nothing to repair',
    });
  }

  // Decide each line on its own evidence, then group the decisions.
  const decided = lines.map((line) => {
    const result = repair(line.content, opts);
    return {
      content: line.content,
      eol: line.eol,
      id: result.confident && result.changed ? result.encoding : null,
      value: result.confident && result.changed ? result.value : line.content,
      reason: result.reason,
    };
  });

  // An ASCII line repairs to itself under every codec, so its "winner" is
  // arbitrary. Give those lines to their neighbours instead of letting them
  // split the document into meaningless segments. Absorption can leave a block
  // abutting a segment that already had the id it was handed, so the result is
  // re-merged: a segment is a RUN of lines, and two adjacent runs of the same
  // codec are one run.
  //
  // Only PURE ASCII absorbs, and that restriction is load-bearing. A line that
  // is non-ASCII but undecided is not codec-neutral: it is a broken line too
  // short to carry enough signal to be detected on its own. Letting it adopt a
  // neighbour's codec hands it a decision made by a different script's
  // evidence, and the result is worse than useless -- French lines absorbed
  // into a Russian cp1251 segment were repaired *as Cyrillic*, which is exactly
  // the damage this whole module exists to prevent. Such lines stay in their own
  // segment and get the block repair below, which is the mechanism built for
  // them.
  const grouped = mergeAdjacent(
    absorbUnchanged(
      groupSegments(decided).map((seg) => ({
        id: seg.id,
        lines: seg.lines,
        unchanged: seg.id === null && seg.lines.every((l) => !/[^\x00-\x7f]/.test(l.content)),
      }))
    )
  );

  const segments = [];
  let out = '';
  let repairedSegments = 0;
  let refusedSegments = 0;

  for (const seg of grouped) {
    const raw = seg.lines.map((l) => l.content + l.eol).join('');

    // Re-run the whole segment under the codec that won for its lines. Scoring a
    // segment as a unit rather than line by line is what makes a two-line French
    // paragraph recoverable: one French line may not carry enough signal alone.
    //
    // A segment with no id has no winner to test, but it still gets the attempt.
    // Refusing it outright skipped the one mechanism that exists for lines too
    // short to be judged individually, and left them broken while their
    // neighbours were repaired. The block is only accepted when the whole of it
    // repairs confidently, which cannot fire on correct text: a clean block
    // scores zero and is refused.
    const joined = repair(raw, opts);
    const segmentDecides =
      seg.id !== null
        ? joined.confident && joined.changed && agreesWithLines(seg.lines, joined.encoding)
        : joined.confident && joined.changed;

    if (!segmentDecides) {
      if (seg.id === null) {
        // No confident codec for this run of lines: keep the original bytes.
        refusedSegments += 1;
        segments.push({
          encoding: null,
          lines: seg.lines.length,
          changed: false,
          reason: 'no codec repaired this segment confidently; left unchanged',
        });
        out += raw;
        continue;
      }
      // The unit repair did not carry the segment. Keep each line's own result,
      // which is at least as good as the input: a line repaired individually
      // stays repaired, and a line that could not be stays byte-identical.
      const perLine = seg.lines.map((l) => (l.id === seg.id ? l.value : l.content) + l.eol).join('');
      if (perLine !== raw) repairedSegments += 1;
      segments.push({
        encoding: seg.id,
        lines: seg.lines.length,
        changed: perLine !== raw,
        reason:
          perLine === raw
            ? 'segment repaired to an identical value; left unchanged'
            : `repaired as ${seg.id} line by line`,
      });
      out += perLine;
      continue;
    }

    if (joined.value !== raw) repairedSegments += 1;
    segments.push({
      encoding: seg.id === null ? joined.encoding : seg.id,
      lines: seg.lines.length,
      changed: joined.value !== raw,
      reason:
        joined.value === raw
          ? 'segment repaired to an identical value; left unchanged'
          : `repaired as ${seg.id === null ? joined.encoding : seg.id}`,
    });
    out += joined.value;
  }

  const changed = out !== original;
  // The segments keep reporting what WOULD be done and under which codec, which
  // is the entire point of --detect-only: the caller asked for a decision per
  // segment, not a rewrite. Only `value` is withheld, and `changed` follows it,
  // so no output path can write or announce text it was told not to touch.
  return Object.freeze({
    value: detectOnly ? original : out,
    original,
    changed: detectOnly ? false : changed,
    segments: Object.freeze(segments),
    repairedSegments,
    refusedSegments,
    reason: detectOnly
      ? `would repair ${repairedSegments} of ${segments.length} segment(s) individually` +
        (refusedSegments > 0 ? `, ${refusedSegments} refused` : '') +
        '; --detect-only, text unchanged'
      : changed
        ? `repaired ${repairedSegments} of ${segments.length} segment(s) individually` +
          (refusedSegments > 0 ? `, ${refusedSegments} refused` : '')
        : 'no segment could be repaired confidently; returned unchanged',
  });
}

module.exports = Object.freeze({
  DEFAULTS,
  ENCODINGS,
  STRATEGY_IDS,
  detect,
  repair,
  repairMixed,
});