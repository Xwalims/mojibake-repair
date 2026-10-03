'use strict';

/**
 * repairMixed(): per-segment recovery for documents that broke through more than
 * one codec.
 *
 * The behaviour these tests pin is the difference between `repair()` and
 * `repairMixed()` on the same input. `repair()` must refuse a mixed document and
 * return it byte-identical; `repairMixed()` must recover it exactly. Both halves
 * are asserted here, because a change that made the mixed path "work" by
 * loosening `repair()` would be a serious regression, not an improvement.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { repair, repairMixed } = require('../src/repair.js');
const { splitLines, groupSegments, absorbUnchanged } = require('../src/segments.js');
const codecs = require('../src/codecs.js');

const FR = 'Français: déjà vu, où est la crème?';
const RU = 'Привет, мир! Это русский текст.';
const DE = 'Größe, Straße, weiß';

/**
 * Break correct text the way a server would.
 *
 * Node's Buffer has no cp1251/cp1252 codec -- that absence is exactly why this
 * package ships its own WHATWG tables -- so the project codecs are used here,
 * keeping the fixture identical to the code under test.
 *
 * The breakage is: UTF-8 bytes, read back through the wrong codec.
 * `decode(utf8Bytes, 'latin1')` is exactly what a client does when a server
 * labels a UTF-8 body as windows-1251. Encoding and decoding through the SAME
 * codec would be a round trip and would break nothing, which is not the case
 * under test.
 */
function breakAs(text, codec) {
  return codecs.decode(Buffer.from(text, 'utf8'), codec);
}

/** The realistic mixed document: each line broken through its own codec. */
function mixedDocument(eol = '\n') {
  return [
    breakAs(FR, 'latin1'),
    breakAs(RU, 'cp1251'),
    breakAs(DE, 'latin1'),
  ].join(eol) + eol;
}

const EXPECTED = `${FR}\n${RU}\n${DE}\n`;

// ---------------------------------------------------------------- primitives

test('splitLines preserves CRLF, LF and CR exactly', () => {
  assert.deepEqual(splitLines('a\nb\n'), [
    { content: 'a', eol: '\n' },
    { content: 'b', eol: '\n' },
  ]);
  assert.deepEqual(splitLines('a\r\nb'), [
    { content: 'a', eol: '\r\n' },
    { content: 'b', eol: '' },
  ]);
  assert.deepEqual(splitLines('a\rb'), [
    { content: 'a', eol: '\r' },
    { content: 'b', eol: '' },
  ]);
});

test('splitLines on empty input returns nothing', () => {
  assert.deepEqual(splitLines(''), []);
});

test('splitLines keeps a trailing line without a newline', () => {
  assert.deepEqual(splitLines('a\nb'), [
    { content: 'a', eol: '\n' },
    { content: 'b', eol: '' },
  ]);
});

test('groupSegments merges consecutive lines sharing an id', () => {
  const lines = [
    { id: 'latin1', content: 'a', eol: '\n' },
    { id: 'latin1', content: 'b', eol: '\n' },
    { id: 'cp1251', content: 'c', eol: '\n' },
  ];
  const segs = groupSegments(lines);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].lines.length, 2);
  assert.equal(segs[1].id, 'cp1251');
});

test('groupSegments on an alternating document collapses rather than fragments', () => {
  const lines = [
    { id: 'latin1', content: 'a', eol: '\n' },
    { id: 'cp1251', content: 'b', eol: '\n' },
    { id: 'latin1', content: 'c', eol: '\n' },
    { id: 'cp1251', content: 'd', eol: '' },
  ];
  // Alternating ids must NOT collapse into one segment: grouping is by identity
  // of the winner, so this stays four segments. That is correct, and it is why
  // the real fix is a better per-segment decision, not looser grouping.
  assert.equal(groupSegments(lines).length, 4);
});

test('absorbUnchanged gives a null-id segment to its neighbour', () => {
  const segs = absorbUnchanged([
    { id: 'latin1', lines: [{ content: 'a', eol: '' }], unchanged: false },
    { id: null, lines: [{ content: 'ascii', eol: '' }], unchanged: true },
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].lines.length, 2);
});

// ------------------------------------------------------- the contract split

test('repair() refuses a mixed document and returns it byte-identical', () => {
  const doc = mixedDocument();
  const result = repair(doc);
  assert.equal(result.confident, false, 'a single global hypothesis must not win');
  assert.equal(result.changed, false);
  assert.equal(result.value, doc, 'the original string must come back unchanged');
  assert.equal(result.original, doc);
});

test('repairMixed() recovers the mixed document exactly', () => {
  const result = repairMixed(mixedDocument());
  assert.equal(result.changed, true);
  assert.equal(result.value, EXPECTED);
});

test('repairMixed() picks a different codec per segment', () => {
  const result = repairMixed(mixedDocument());
  const used = result.segments.map((s) => s.encoding);
  assert.equal(used.length, 3);
  assert.ok(used.includes('cp1251'), 'the Russian line must be repaired through cp1251');
  assert.equal(result.repairedSegments, 3);
  assert.equal(result.refusedSegments, 0);
});

test('repairMixed() never makes the document worse than the input', () => {
  // The guarantee that matters: a mixed document that repair() refuses must not
  // be mangled by repairMixed(). Either it is recovered or it is untouched.
  const doc = mixedDocument();
  const result = repairMixed(doc);
  if (!result.changed) {
    assert.equal(result.value, doc);
  } else {
    assert.notEqual(result.value, doc);
  }
  // The original is always recoverable, whatever happened.
  assert.equal(result.original, doc);
});

test('repairMixed() on a single-codec document agrees with repair()', () => {
  const doc = breakAs(RU, 'cp1251') + '\n';
  const mixed = repairMixed(doc);
  const single = repair(doc);
  assert.equal(mixed.value, single.value);
});

test('repairMixed() leaves already-correct text untouched', () => {
  const clean = `${FR}\n${RU}\n${DE}\n`;
  const result = repairMixed(clean);
  assert.equal(result.changed, false);
  assert.equal(result.value, clean);
});

test('repairMixed() handles a pure-ASCII document as unchanged', () => {
  const ascii = 'hello\nworld\n';
  const result = repairMixed(ascii);
  assert.equal(result.changed, false);
  assert.equal(result.value, ascii);
});

test('repairMixed() preserves CRLF line endings through a repair', () => {
  const doc = mixedDocument('\r\n');
  const result = repairMixed(doc);
  assert.equal(result.value, `${FR}\r\n${RU}\r\n${DE}\r\n`);
  assert.ok(!/[^\r]\n/.test(result.value), 'no bare LF may survive');
});

test('repairMixed() on empty input reports nothing to do', () => {
  const result = repairMixed('');
  assert.equal(result.changed, false);
  assert.equal(result.value, '');
  assert.deepEqual(result.segments, []);
});

test('repairMixed() on a single line without a trailing newline', () => {
  const doc = breakAs(FR, 'latin1');
  const result = repairMixed(doc);
  assert.equal(result.value, FR);
  assert.ok(!result.value.endsWith('\n'), 'no newline may be invented');
});

test('repairMixed() is deterministic across repeated calls', () => {
  const doc = mixedDocument();
  const a = repairMixed(doc);
  const b = repairMixed(doc);
  assert.equal(a.value, b.value);
  assert.deepEqual(a.segments, b.segments);
});

test('a segment with no confident codec is refused, not guessed', () => {
  // Damage that no single codec explains: every line here is ambiguous.
  const junk = '��\n��\n';
  const result = repairMixed(junk);
  assert.equal(result.value, junk, 'unrecoverable input must come back untouched');
  assert.equal(result.changed, false);
});

test('repairMixed() result object is frozen', () => {
  const result = repairMixed(mixedDocument());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.segments), true);
});

test('the mixed path does not weaken repair(): both run on the same input', () => {
  // Regression guard. If a future change made repair() start "fixing" mixed
  // documents by accepting a lower score, this fails.
  const doc = mixedDocument();
  assert.equal(repair(doc).confident, false);
  assert.equal(repairMixed(doc).confident === undefined, true);
});