'use strict';

/**
 * Mixed-encoding recovery, segment by segment.
 *
 * ## Why this exists
 *
 * A document can break through more than one codec. The commonest real case:
 * a French line served as cp1252 and a Russian line served as cp1251 in the
 * same file. No single global hypothesis repairs such a document, because
 * every codec destroys at least one segment:
 *
 *   - repairing as latin1 mangles the Russian line's `0x9F`-range bytes;
 *   - repairing as cp1252 remaps those same bytes to typographic punctuation.
 *
 * `repair()` correctly refuses such input and returns the original untouched.
 * That is the right call for a whole-document guess, but it leaves real data
 * unrecovered: each line is independently repairable, and the information needed
 * to repair it is present in the line itself.
 *
 * So this module makes the per-segment decision the primary one. It picks the
 * best codec *for each segment independently* and only refuses when a segment
 * itself cannot be repaired confidently.
 *
 * ## What a segment is
 *
 * A run of consecutive lines that share one winning codec. Grouping happens
 * after scoring, so lines broken through the same codec and placed together
 * form ONE segment however short each line is -- but a document that alternates
 * codecs on every line yields one segment per line, because merging across a run
 * boundary would apply a single codec to lines the evidence does not support.
 *
 * The per-line decision is what finds the runs; the segment is the unit that
 * gets repaired. A line too short to detect on its own therefore need not be
 * lost: it is repaired by the block around it, which is the whole reason this
 * module exists instead of a loop over lines. See `repairMixed()`.
 */

/**
 * Split text into lines, remembering the exact separators.
 *
 * @param {string} text
 * @returns {Array<{content: string, eol: string}>}
 */
function splitLines(text) {
  if (text === '') return [];
  // A bare CR is a line terminator in its own right, so the pattern must match
  // \r separately from \n and \r\n. Written as `[^\n]*\n|[^\n]+` it silently
  // swallowed a lone CR, leaving "a\rb" as one line.
  const parts = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/g);
  if (!parts) return [{ content: text, eol: '' }];
  return parts.map((raw) => {
    if (raw.endsWith('\r\n')) return { content: raw.slice(0, -2), eol: '\r\n' };
    if (raw.endsWith('\n')) return { content: raw.slice(0, -1), eol: '\n' };
    if (raw.endsWith('\r')) return { content: raw.slice(0, -1), eol: '\r' };
    return { content: raw, eol: '' };
  });
}

/**
 * Group consecutive lines that resolved to the same codec.
 *
 * Only ADJACENT lines sharing an id are merged. A document that alternates
 * codecs on every line therefore yields one segment per line, while a document
 * broken in runs collapses to one segment per run. That is deliberate: a
 * segment is a run of lines, and merging across a run boundary would apply one
 * codec to lines the evidence does not support.
 *
 * The WHOLE line object is stored, not just its text. `id` and `value` are what
 * let repairMixed() fall back to per-line repairs when a segment cannot be
 * repaired as a unit. Discarding them made that fallback dead code -- every
 * `l.id === seg.id` test compared `undefined` against a codec name and so was
 * always false -- which meant a segment that failed the unit test kept its
 * BROKEN bytes even for the lines it had already repaired individually.
 *
 * @param {Array<{content: string, eol: string, id: string|null, value?: string}>} lines
 * @returns {Array<{id: string|null, lines: Array<object>}>}
 */
function groupSegments(lines) {
  const segments = [];
  for (const line of lines) {
    const last = segments[segments.length - 1];
    if (last && last.id === line.id) {
      last.lines.push(line);
    } else {
      segments.push({ id: line.id, lines: [line] });
    }
  }
  return segments;
}

/**
 * Merge neighbouring segments that ended up with the same id.
 *
 * `absorbUnchanged()` gives a leading block of undecided lines the id of the
 * first decided segment. When that block is immediately followed by a segment
 * which already had that id, absorption creates two adjacent segments carrying
 * the same codec -- a split the caller never asked for and cannot see the
 * reason for. Re-merging here keeps "a segment is a run of lines" true.
 *
 * @param {Array<{id: string|null, lines: Array<object>}>} segments
 * @returns {Array<{id: string|null, lines: Array<object>}>}
 */
function mergeAdjacent(segments) {
  const out = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.id === seg.id) {
      prev.lines = prev.lines.concat(seg.lines);
      continue;
    }
    out.push({ id: seg.id, lines: seg.lines.slice() });
  }
  return out;
}

/**
 * Merge neighbouring segments when one side had nothing to contribute.
 *
 * A segment whose repair was a no-op carries no evidence about its own codec —
 * ASCII breaks through every codec identically. Such a segment should adopt its
 * neighbour's choice rather than fragment the document.
 *
 * @param {Array<{id: string, lines: Array<object>, unchanged: boolean}>} segments
 * @returns {Array<{id: string, lines: Array<object>}>}
 */
function absorbUnchanged(segments) {
  const out = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (seg.unchanged && prev) {
      prev.lines.push(...seg.lines);
      continue;
    }
    if (seg.unchanged && !prev && segments.length > 1) {
      // Leading unchanged block: defer, it may merge with whatever follows.
      out.push({ id: seg.id, lines: [...seg.lines], pending: true });
      continue;
    }
    out.push({ id: seg.id, lines: [...seg.lines], pending: false });
  }
  // A pending leading block adopts the id of the first decided segment.
  const firstDecided = out.find((s) => !s.pending);
  if (firstDecided) {
    for (const seg of out) {
      if (seg.pending) seg.id = firstDecided.id;
    }
  }
  return out.map((s) => ({ id: s.id, lines: s.lines }));
}

module.exports = Object.freeze({
  splitLines,
  groupSegments,
  mergeAdjacent,
  absorbUnchanged,
});