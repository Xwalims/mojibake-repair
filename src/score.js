'use strict';

// Ranking of repair candidates.
//
// A repair is only trustworthy if the result looks better than the input by
// several independent measures. Any single measure is gameable -- "more
// accented characters" rewards mangling, "fewer high bytes" rewards deleting --
// so the score is a weighted sum of orthogonal checks, and any candidate that
// introduced data loss is disqualified outright.
//
// ---------------------------------------------------------------------------
// WEIGHTS AND WHY
// ---------------------------------------------------------------------------
// The five components, in descending weight:
//
//  1. REPLACEMENT CHARS  (-100, disqualifying)
//     U+FFFD means bytes were thrown away and can never be recovered. A
//     candidate that introduces one has destroyed information, however readable
//     the result looks. This is not a weight to tune: it is a veto, so it is
//     applied as a hard filter in `isEligible` and the penalty exists only to
//     order the display of candidates in --explain.
//
//     SUBSTITUTED CHARS (-100, disqualifying) is the same veto for the other
//     silent loss. encode() replaces a code point its codec cannot hold with
//     U+003F, which is a perfectly printable ASCII character, so the damage is
//     invisible in the result. Left uncounted it made the score actively prefer
//     the candidate that deletes the most text: a fully '?'-substituted value
//     has no artefacts, one coherent script and 100% printable, so it outscored
//     the lossless answer. The count has to be supplied by the caller, which is
//     the only place the codec is known.
//
//  2. SCRIPT CONSISTENCY  (+30)
//     Broken UTF-8-as-latin1 text is a mix of Latin letters and stray symbols;
//     the repaired text is one coherent script. This is the single most
//     discriminating cheap signal: it separates "Ã© -> é" from a candidate that
//     leaves a pile of Ã/Â fragments, and it is what makes Russian text not
//     score as a Latin/Cyrillic mixture. Weight is high because it cannot be
//     gamed by shortening the text.
//
//  3. ARTEFACT DENSITY  (+25)
//     Count of remaining known mojibake artefacts per non-ASCII character. A
//     real repair drives this to zero. Normalised by non-ASCII count so that a
//     long and a short candidate are comparable.
//
//  4. PRINTABLE RATIO  (+15)
//     Share of characters that are printable, letter, digit, common punctuation
//     or whitespace. Catches control characters and stray symbol soup. Lower
//     weight than script consistency because it is a blunt instrument.
//
//  5. LANGUAGE HINT  (+12)
//     A small frequency bonus for common words of a handful of languages. This
//     is deliberately weak: it breaks ties between two otherwise equal
//     candidates, it does not carry decisions. A repair tool must not be able to
//     declare text corrupt merely because it is in a language it has never heard
//     of.
//
// Total possible positive score is 82, normalised to [0, 1] by dividing by the
// sum of the positive weights.
//
// DETERMINISM: the score depends only on (candidate value, original value).
// No randomness, no locale-sensitive comparison, no iteration over a Map whose
// insertion order varies. Ties are broken by the fixed STRATEGIES order in
// candidates.js, so the same input always produces the same ranking.

const { measure } = require('./detect.js');
const { CONTINUATION, isC1, isLead, scanPairs } = require('./structure.js');

/** Weights. Exported so the CLI can print them and tests can assert them. */
const WEIGHTS = Object.freeze({
  replacementChars: -100, // disqualifying in practice; see `eligible`
  substitutedChars: -100, // likewise; see the note in scoreCandidate()
  scriptConsistency: 30,
  artefactDensity: 25,
  printableRatio: 15,
  languageHint: 12,
});

/** Sum of the positive weights, used to normalise the score to [0, 1]. */
const MAX_POSITIVE = Object.freeze(
  WEIGHTS.scriptConsistency +
    WEIGHTS.artefactDensity +
    WEIGHTS.printableRatio +
    WEIGHTS.languageHint
);

/**
 * Scripts that count as "one coherent script" for the consistency check.
 */
const SCRIPTS = Object.freeze([
  'Latin',
  'Cyrillic',
  'Greek',
  'Arabic',
  'Hebrew',
  'Han',
  'Hiragana',
  'Katakana',
  'Hangul',
  'Thai',
  'Devanagari',
]);

/**
 * Small, high-frequency word lists. Deliberately tiny: enough to break ties,
 * not enough to make a language judgement. Words are lower-case and matched on
 * whole words only.
 */
const HINTS = Object.freeze({
  en: Object.freeze(['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'it', 'with', 'this', 'was']),
  fr: Object.freeze(['le', 'la', 'les', 'de', 'des', 'et', 'est', 'une', 'que', 'pour', 'dans', 'vous']),
  es: Object.freeze(['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'por', 'con', 'es', 'está']),
  pt: Object.freeze(['o', 'a', 'os', 'as', 'de', 'que', 'e', 'em', 'um', 'uma', 'para', 'com', 'não']),
  de: Object.freeze(['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'von', 'zu', 'sich']),
  ru: Object.freeze(['и', 'в', 'не', 'на', 'что', 'с', 'по', 'это', 'как', 'к', 'но', 'все']),
  uk: Object.freeze(['і', 'й', 'та', 'не', 'на', 'що', 'це', 'як', 'для', 'але']),
  tr: Object.freeze(['bir', 've', 'bu', 'için', 'ile', 'daha', 'çok', 'olarak', 'var', 'ama']),
  pl: Object.freeze(['nie', 'się', 'jest', 'na', 'do', 'to', 'że', 'w', 'z', 'i']),
  cs: Object.freeze(['je', 'na', 'se', 'že', 'do', 'to', 'a', 'v', 'z', 'pro']),
  nl: Object.freeze(['de', 'het', 'een', 'van', 'en', 'is', 'dat', 'te', 'niet', 'op']),
  sv: Object.freeze(['och', 'att', 'det', 'som', 'en', 'är', 'för', 'på', 'inte', 'med']),
});


/**
 * Letter classification per Unicode script, as a predicate over code points.
 * Uses the Unicode property escapes available in Node 20+, which are exact and
 * require no tables.
 */
const SCRIPT_TESTS = Object.freeze({
  Latin: /\p{Script=Latin}/u,
  Cyrillic: /\p{Script=Cyrillic}/u,
  Greek: /\p{Script=Greek}/u,
  Arabic: /\p{Script=Arabic}/u,
  Hebrew: /\p{Script=Hebrew}/u,
  Han: /\p{Script=Han}/u,
  Hiragana: /\p{Script=Hiragana}/u,
  Katakana: /\p{Script=Katakana}/u,
  Hangul: /\p{Script=Hangul}/u,
  Thai: /\p{Script=Thai}/u,
  Devanagari: /\p{Script=Devanagari}/u,
});

/**
 * A code point is "printable text" if it is a letter, number, mark, punctuation,
 * symbol, separator or whitespace. Everything else (control characters, private
 * use, unassigned, surrogates) is not.
 */
const PRINTABLE = /[\p{L}\p{N}\p{M}\p{P}\p{S}\p{Zs}\t\n\r]/u;

/**
 * How coherent the scripts in a text are.
 *
 * 1.0 when all letters belong to one script (or there are no letters), falling
 * off with the share of letters outside the dominant script.
 *
 * @param {string} text
 * @returns {{ consistency: number, dominant: string|null, minority: number, letters: number }}
 */
function scriptConsistency(text) {
  const counts = new Map();
  let letters = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    for (const name of SCRIPTS) {
      if (SCRIPT_TESTS[name].test(ch)) {
        counts.set(name, (counts.get(name) || 0) + 1);
        break;
      }
    }
  }
  if (letters === 0) return { consistency: 1, dominant: null, minority: 0, letters: 0 };

  let dominant = null;
  let best = -1;
  // Iterate SCRIPTS (fixed order), not the Map, so ties are deterministic.
  for (const name of SCRIPTS) {
    const n = counts.get(name) || 0;
    if (n > best) {
      best = n;
      dominant = name;
    }
  }
  const minority = letters - best;
  return {
    consistency: best / letters,
    dominant,
    minority,
    letters,
  };
}

/**
 * Printable-character ratio in [0, 1].
 * @param {string} text
 * @returns {number}
 */
function printableRatio(text) {
  const chars = [...text];
  if (chars.length === 0) return 1;
  let printable = 0;
  for (const ch of chars) if (PRINTABLE.test(ch)) printable++;
  return printable / chars.length;
}

/**
 * Count surviving mojibake artefacts and measure how damaged the text looks.
 *
 * Two flavours of damage, counted together:
 *
 *   byte pairs     a UTF-8 lead byte still adjacent to a continuation character,
 *                  i.e. a sequence that was never decoded
 *   cyrillic extras  Cyrillic letters sitting on windows-1251's 0x80-0xBF block
 *
 * Both are needed. Russian misdecoded through windows-1251 produces CLEAN Cyrillic
 * with zero byte pairs -- nothing about its bytes looks wrong -- and is identified
 * only by its Cyrillic composition. Counting byte pairs alone would score that
 * repair as making zero progress, because the broken and repaired forms are
 * equally pair-free, and would reject a perfectly good repair for the wrong
 * reason.
 *
 * @param {string} text
 * @returns {{ count: number, pairs: number, cyrillicExtras: number, density: number }}
 */
function artefactDensity(text) {
  const scanned = scanPairs(text);
  const m = measure(text);
  const count = scanned.pairs + m.cyrillicExtras;
  return {
    count,
    pairs: scanned.pairs,
    cyrillicExtras: m.cyrillicExtras,
    density: count / Math.max(m.nonAscii, 1),
  };
}

/**
 * Small language hint: how many high-frequency words appear, normalised.
 * @param {string} text
 * @returns {{ hits: number, languages: string[], ratio: number }}
 */
function languageHint(text) {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{M}']+/u)
    .filter(Boolean);
  if (words.length === 0) return { hits: 0, languages: [], ratio: 0 };

  const wordSet = new Set(words);
  const languages = [];
  let hits = 0;
  for (const [lang, list] of Object.entries(HINTS)) {
    let n = 0;
    for (const word of list) if (wordSet.has(word)) n++;
    if (n > 0) {
      languages.push(lang);
      hits += n;
    }
  }
  // 3 hits already counts as a full hint; beyond that it stops adding signal.
  return { hits, languages, ratio: Math.min(hits / 3, 1) };
}

/**
 * Score one candidate value against the original text.
 *
 * Deterministic: pure function of its arguments. Returns the component breakdown
 * as well as the total so `--explain` can show its work.
 *
 * @param {string} value candidate repaired text
 * @param {string} original the broken input
 * @returns {{
 *   score: number, eligible: boolean, components: object,
 *   replacementChars: number, printable: number, consistency: number,
 *   artefactCount: number, artefactDensity: number,
 *   hints: string[], hintRatio: number, dominantScript: string|null
 * }}
 */
function scoreCandidate(value, original, options = {}) {
  const text = String(value);
  const m = measure(text);
  const scripts = scriptConsistency(text);
  const printable = printableRatio(text);
  const artefacts = artefactDensity(text);
  const hint = languageHint(text);

  // Characters the generating codec could not represent and silently replaced
  // with U+003F. Passed in by the caller, which is the only place the codec is
  // known; counted as damage for exactly the same reason U+FFFD is.
  //
  // This is not cosmetic. U+003F is a printable ASCII character, so a candidate
  // that has deleted half a document scores as CLEAN on every other measure --
  // it has no artefacts, its scripts are consistent, it is entirely printable --
  // and used to win. Without this term the ranking actively prefers the
  // candidate that destroys the most text.
  const substituted = Number.isInteger(options.substituted) ? options.substituted : 0;

  // Quality of the candidate is measured against the *original* artefact count:
  // a candidate that leaves fewer artefacts than the input made progress, and
  // one that leaves more made it worse.
  const originalArtefacts = artefactDensity(String(original)).count;
  const artefactProgress = Math.min(
    Math.max(originalArtefacts - artefacts.count, 0) / Math.max(originalArtefacts, 1),
    1
  );

  const components = {
    scriptConsistency: WEIGHTS.scriptConsistency * scripts.consistency,
    artefactDensity: WEIGHTS.artefactDensity * artefactProgress,
    printableRatio: WEIGHTS.printableRatio * printable,
    languageHint: WEIGHTS.languageHint * hint.ratio,
    replacementChars:
      m.replacementChars > 0 ? WEIGHTS.replacementChars * m.replacementChars : 0,
    substitutedChars:
      substituted > 0 ? WEIGHTS.substitutedChars * substituted : 0,
  };

  const raw =
    components.scriptConsistency +
    components.artefactDensity +
    components.printableRatio +
    components.languageHint +
    components.replacementChars +
    components.substitutedChars;

  // Normalise to [0, 1] against the achievable maximum. A candidate carrying
  // replacement characters cannot go above 0, because the penalty alone exceeds
  // the whole positive budget.
  const score = Math.max(0, Math.min(raw / MAX_POSITIVE, 1));

  return {
    score: Number(score.toFixed(6)),
    // Data loss is a veto, not a penalty. Both forms count: U+FFFD for a byte
    // that could not be decoded, and U+003F for a code point the codec could
    // not represent.
    eligible: m.replacementChars === 0 && substituted === 0,
    components,
    replacementChars: m.replacementChars,
    substitutedChars: substituted,
    printable: Number(printable.toFixed(6)),
    consistency: Number(scripts.consistency.toFixed(6)),
    dominantScript: scripts.dominant,
    minorityLetters: scripts.minority,
    artefactCount: artefacts.count,
    artefactDensity: Number(artefacts.density.toFixed(6)),
    originalArtefacts,
    hints: hint.languages,
    hintRatio: Number(hint.ratio.toFixed(6)),
  };
}

/**
 * Rank candidates. Input order is preserved for equal scores, and since
 * candidates.js generates in a fixed STRATEGIES order the ranking is fully
 * deterministic for a given input.
 *
 * @param {ReadonlyArray<object>} candidates from generateCandidates
 * @param {string} original
 * @param {{ minScore?: number }} [options]
 * @returns {ReadonlyArray<object>} candidates with `score`, `changed`, `parts`, best first
 */
function rankCandidates(candidates, original, options = {}) {
  const minScore = options.minScore === undefined ? 0 : Number(options.minScore);
  const scored = [];

  for (const candidate of candidates) {
    if (candidate.value === null || candidate.error) {
      scored.push(
        Object.freeze({
          ...candidate,
          score: 0,
          changed: false,
          eligible: false,
          reason: candidate.error || 'no value',
          parts: null,
          substitutedChars: 0,
        })
      );
      continue;
    }
    const parts = scoreCandidate(candidate.value, original, {
      // candidates.js names this `substituted`; the scorer reports it as
      // `substitutedChars` alongside `replacementChars`. Both spellings exist
      // because one is what the generator measured and the other is what the
      // score breakdown publishes.
      substituted: candidate.substituted,
    });
    scored.push(
      Object.freeze({
        ...candidate,
        score: parts.score,
        changed: candidate.value !== original,
        eligible: parts.eligible,
        reason: describe(parts, candidate.value !== original),
        parts: Object.freeze(parts),
        substitutedChars: parts.substitutedChars,
      })
    );
  }

  // Stable sort: Array#sort is specified as stable in ES2019+, so equal scores keep
  // generation order. Comparison is on score alone -- no localeCompare, no ties
  // broken by string value, so the result cannot vary by environment.
  const ranked = scored.sort((a, b) => b.score - a.score);
  return Object.freeze(
    ranked.map((c) => Object.freeze({ ...c, aboveThreshold: c.score >= minScore }))
  );
}

/**
 * One-line explanation of a candidate's score.
 * @param {object} parts
 * @param {boolean} changed
 * @returns {string}
 */
function describe(parts, changed) {
  const bits = [
    `score ${parts.score.toFixed(3)}`,
    `printable ${(parts.printable * 100).toFixed(0)}%`,
    `script ${parts.dominantScript || 'none'} ${(parts.consistency * 100).toFixed(0)}%`,
    `artefacts ${parts.artefactCount}`,
  ];
  if (parts.hints.length) bits.push(`hints ${parts.hints.join(',')}`);
  if (!parts.eligible) {
    const lost = [];
    if (parts.replacementChars) lost.push(`${parts.replacementChars} replacement chars`);
    if (parts.substitutedChars) lost.push(`${parts.substitutedChars} substituted chars`);
    bits.push(`DISQUALIFIED: ${lost.join(' and ')}`);
  } else if (!changed) bits.push('no change');
  return bits.join(', ');
}

/**
 * The score a candidate must beat before repair() will use it. Exported as a
 * frozen constant; see repair.js for how it is applied.
 */
const DEFAULT_MIN_SCORE = 0.6;

module.exports = Object.freeze({
  CONTINUATION,
  DEFAULT_MIN_SCORE,
  HINTS,
  MAX_POSITIVE,
  SCRIPTS,
  WEIGHTS,
  artefactDensity,
  describe,
  isLead,
  languageHint,
  printableRatio,
  rankCandidates,
  scoreCandidate,
  scriptConsistency,
});