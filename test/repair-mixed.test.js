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
const { splitLines, groupSegments, mergeAdjacent, absorbUnchanged } = require('../src/segments.js');
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

test('groupSegments on an alternating document keeps one segment per run', () => {
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

test('groupSegments stores each whole line, so per-line values survive grouping', () => {
  // repairMixed() falls back to per-line results when a segment cannot be
  // repaired as a unit, and it reads them back off these objects. Storing only
  // {content, eol} made that fallback dead: `l.id === seg.id` compared
  // `undefined` to a codec name and was always false, so a segment that failed
  // the unit test discarded the repairs it had already made per line.
  const lines = [
    { id: 'cp1251', content: 'a', eol: '\n', value: 'A' },
    { id: 'cp1251', content: 'b', eol: '\n', value: 'B' },
  ];
  const segs = groupSegments(lines);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].lines.length, 2);
  assert.deepEqual(segs[0].lines.map((l) => l.value), ['A', 'B']);
  assert.deepEqual(segs[0].lines.map((l) => l.id), ['cp1251', 'cp1251']);
});

test('mergeAdjacent rejoins two adjacent segments that share an id', () => {
  // absorbUnchanged() hands an undecided block the id of its first decided
  // neighbour. When that block is followed by a segment which already had that
  // id, absorption produces two adjacent segments of the same codec -- a split
  // that makes the segment-as-unit rescue fire on half the block.
  const merged = mergeAdjacent([
    { id: 'latin1', lines: [{ content: 'a', eol: '' }] },
    { id: 'latin1', lines: [{ content: 'b', eol: '' }] },
    { id: 'cp1251', lines: [{ content: 'c', eol: '' }] },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'latin1');
  assert.equal(merged[0].lines.length, 2);
  assert.equal(merged[1].id, 'cp1251');
});

test('mergeAdjacent does not touch segments that differ', () => {
  const merged = mergeAdjacent([
    { id: 'latin1', lines: [{ content: 'a', eol: '' }] },
    { id: 'cp1251', lines: [{ content: 'b', eol: '' }] },
    { id: null, lines: [{ content: 'c', eol: '' }] },
  ]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((s) => s.id), ['latin1', 'cp1251', null]);
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

// ------------------------------------------------------ regressions, real bugs

// Each of these was found by a differential against Python's own codec tables,
// which produce the broken text independently of this project's tables.

test('repairMixed() recovers short lines that only repair as a block', () => {
  // "Ça va" and "Très bien" are individually undetectable: one artefact pair
  // each, below the two-pair detection guard. Joined into a block they carry
  // enough signal, and the segment-as-unit repair recovers them. They used to
  // come back BROKEN -- the same text repaired fine a few lines later in the
  // document, so the defect was positional rather than content-dependent.
  //
  // The French lines stay adjacent to each other on purpose. A lone
  // undetectable line wedged between two DIFFERENT scripts stays unrecovered:
  // its neighbours disagree about which codec it broke through, no block it
  // belongs to is monolingual, and refusing it is the correct answer. That limit
  // is pinned separately below.
  const doc = ['Ça va', 'Très bien', 'Où ça', 'Привет, мир!', 'Это русский текст.']
    .map((line) => (/[Ѐ-ӿ]/.test(line) ? breakAs(line, 'cp1251') : breakAs(line, 'cp1252')))
    .join('\n');
  const result = repairMixed(doc);
  assert.equal(result.value, 'Ça va\nTrès bien\nOù ça\nПривет, мир!\nЭто русский текст.');
});

test('repairMixed() refuses an undetectable line between two scripts, not guesses', () => {
  // "L'hôtel" alone carries one artefact pair, and its French neighbours and
  // Russian neighbours disagree about its codec. Refusing it is right; the
  // guarantee under test is that the refusal is byte-exact and that the lines
  // around it are still repaired.
  const doc = ['Où ça', "L'hôtel", 'Привет, мир!']
    .map((line) => (/[Ѐ-ӿ]/.test(line) ? breakAs(line, 'cp1251') : breakAs(line, 'cp1252')))
    .join('\n');
  const result = repairMixed(doc);
  assert.equal(result.value, "Où ça\nL'hÃ´tel\nПривет, мир!");
  assert.equal(result.refusedSegments, 1, 'the lone ambiguous line is refused');
  // The refusal must not drag its neighbours down with it.
  assert.ok(result.value.includes('Où ça'), 'the detectable French line is still repaired');
  assert.ok(result.value.includes('Привет, мир!'), 'the Russian line is still repaired');
});

test('repairMixed() never repairs a line as a different script than it is', () => {
  // French lines too short to detect on their own were being absorbed into the
  // neighbouring RUSSIAN segment and repaired through cp1251. Absorption was
  // applied to every undecided line, but only a PURE ASCII line is truly neutral
  // between codecs; a non-ASCII undecided line is a broken line awaiting better
  // evidence, and adopting a neighbour's codec corrupted it.
  const doc = ['Ça va', 'Très bien', 'Привет', 'Мир']
    .map((line) => (/[Ѐ-ӿ]/.test(line) ? breakAs(line, 'cp1251') : breakAs(line, 'cp1252')))
    .join('\n');
  const result = repairMixed(doc);
  const cyrillicInFrenchLine = /[Ѐ-ӿ]/.test(
    result.value.split('\n').filter((l) => !/[Ѐ-ӿ]/.test(l)).join('')
  );
  assert.equal(cyrillicInFrenchLine, false, 'French lines must not come back as Cyrillic');
  assert.ok(result.value.includes('Привет'), 'the Russian lines must survive intact');
});

test('repairMixed() keeps a decided line when the block repair disagrees', () => {
  // The unit repair may name an equivalent-but-differently-named codec: latin1
  // and cp1252 are the same codec on text with no C1 byte in it. That must not
  // discard a correct repair. But when the codecs genuinely differ on the line,
  // the per-line result is the one that survives.
  const doc = ['Français: déjà vu, où est la crème?', 'Привет, мир!', 'Это русский текст.']
    .map((line) => (/[Ѐ-ӿ]/.test(line) ? breakAs(line, 'cp1251') : breakAs(line, 'cp1252')))
    .join('\n');
  const result = repairMixed(doc);
  assert.equal(result.value, 'Français: déjà vu, où est la crème?\nПривет, мир!\nЭто русский текст.');
});

test('repairMixed() on a clean multi-script document still returns it unchanged', () => {
  // The block repair now runs even for segments with no per-line winner, so its
  // safety on correct text has to be pinned directly: a clean block scores zero
  // and must be refused.
  const clean = 'Ça va très bien\nПривет, мир!\n日本語のテキスト';
  const result = repairMixed(clean);
  assert.equal(result.value, clean);
  assert.equal(result.changed, false);
});

test('the mixed path does not weaken repair(): both run on the same input', () => {
  // Regression guard. If a future change made repair() start "fixing" mixed
  // documents by accepting a lower score, this fails.
  const doc = mixedDocument();
  assert.equal(repair(doc).confident, false);
  assert.equal(repairMixed(doc).confident === undefined, true);
});