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
 * A run of lines that share one winning codec. Grouping happens after scoring,
 * so a document alternating every line between two codecs still collapses to
 * two segments rather than one segment per line.
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
 * @param {Array<{content: string, eol: string, id: string}>} lines
 * @returns {Array<{id: string, lines: Array<{content: string, eol: string}>}>}
 */
function groupSegments(lines) {
  const segments = [];
  for (const line of lines) {
    const last = segments[segments.length - 1];
    if (last && last.id === line.id) {
      last.lines.push({ content: line.content, eol: line.eol });
    } else {
      segments.push({ id: line.id, lines: [{ content: line.content, eol: line.eol }] });
    }
  }
  return segments;
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
  absorbUnchanged,
});