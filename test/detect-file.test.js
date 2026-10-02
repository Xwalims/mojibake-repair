'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  binaryControlRatio,
  controlRatio,
  decodeFile,
  detectFileEncoding,
  ENCODINGS,
  evaluateUtf16,
  nulRatio,
  nulsByParity,
  validateUtf8,
} = require('../src/detect-file.js');
const { mojibake } = require('../src/codecs.js');
const { CORRECT } = require('./fixtures.js');

test('detect-file: every reported field is present and frozen', () => {
  const result = detectFileEncoding(Buffer.from('hello'));
  for (const field of [
    'encoding',
    'bom',
    'confidence',
    'size',
    'reason',
    'nulRatio',
    'controlRatio',
    'utf8Valid',
  ]) {
    assert.ok(field in result, `missing ${field}`);
  }
  assert.ok(Object.isFrozen(result));
  assert.ok(result.reason.length > 0, 'always explains itself');
});

test('detect-file: confidence is always within [0, 1]', () => {
  const buffers = [
    Buffer.alloc(0),
    Buffer.from('hello'),
    Buffer.from(CORRECT.ru, 'utf8'),
    Buffer.from('hi', 'utf16le'),
    Buffer.alloc(64),
    Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x01, 0x02]),
    Buffer.from(mojibake(CORRECT.fr, 'cp1252')),
  ];
  for (const buffer of buffers) {
    const { confidence } = detectFileEncoding(buffer);
    assert.ok(confidence >= 0 && confidence <= 1, `confidence ${confidence} out of range`);
  }
});

test('detect-file: works on the Buffer, not on a decoded string', () => {
  // A UTF-16 file decoded as UTF-8 first would be full of NULs and controls; the
  // verdict here must come from the raw bytes.
  const utf16 = Buffer.from('Hello world, this is longer text', 'utf16le');
  assert.ok(utf16.includes(0x00), 'fixture really contains NULs');
  const result = detectFileEncoding(utf16);
  assert.equal(result.encoding, 'utf16le');
});

test('detect-file: recognises every BOM with full confidence', () => {
  const cases = [
    [[0xef, 0xbb, 0xbf], 'utf8'],
    [[0xff, 0xfe], 'utf16le'],
    [[0xfe, 0xff], 'utf16be'],
  ];
  for (const [bytes, expected] of cases) {
    const buffer = Buffer.concat([Buffer.from(bytes), Buffer.from('data', 'utf8')]);
    const result = detectFileEncoding(buffer);
    assert.equal(result.encoding, expected);
    assert.equal(result.bom, expected);
    assert.equal(result.confidence, 1, 'a BOM is a declaration, not a guess');
  }
});

test('detect-file: BOM is stripped when decoding', () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('café', 'utf8')]);
  assert.equal(decodeFile(withBom, 'utf8'), 'café', 'no stray U+FEFF at the start');
  assert.ok(!decodeFile(withBom, 'utf8').startsWith('﻿'));
});

test('detect-file: UTF-16 without a BOM is identified by NUL structure', () => {
  // Regression: NUL parity alone read ASCII-in-UTF-16LE ("Hi" = 48 00 69 00) as
  // big-endian. Decoding and scoring plausibility is what gets it right.
  for (const text of ['Hi', 'Hello world', 'Hello world, this is longer text']) {
    const le = Buffer.from(text, 'utf16le');
    assert.equal(detectFileEncoding(le).encoding, 'utf16le', `LE: ${JSON.stringify(text)}`);

    const be = Buffer.from(text, 'utf16le').swap16();
    assert.equal(detectFileEncoding(be).encoding, 'utf16be', `BE: ${JSON.stringify(text)}`);
  }
});

test('detect-file: Cyrillic in UTF-16 is identified despite few NUL padding bytes', () => {
  // Non-Latin text has no zero high bytes, so the NUL fraction is far lower than
  // for ASCII. A fixed NUL threshold would miss this entirely.
  const le = Buffer.from('Привет мир это длинный текст', 'utf16le');
  assert.ok(nulRatio(le) < 0.2, `only ${(nulRatio(le) * 100).toFixed(0)}% NULs, below the old 0.2 threshold`);
  assert.equal(detectFileEncoding(le).encoding, 'utf16le');
});

test('detect-file: round-trips UTF-16 in both byte orders', () => {
  const text = 'Hello, мир!';
  assert.equal(decodeFile(Buffer.from(text, 'utf16le')), text);
  assert.equal(decodeFile(Buffer.from(text, 'utf16le').swap16()), text);

  const withBom = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(text, 'utf16le').swap16(),
  ]);
  assert.equal(decodeFile(withBom), text);
});

test('detect-file: non-ASCII UTF-8 is not mistaken for binary', () => {
  // Regression: the control-byte ratio counted every UTF-8 continuation byte as
  // a control character, so ordinary Russian looked 43% binary.
  for (const key of ['ru', 'ja', 'zh', 'emoji', 'ar', 'he', 'el', 'math']) {
    const buffer = Buffer.from(CORRECT[key], 'utf8');
    const result = detectFileEncoding(buffer);
    assert.equal(result.encoding, 'utf8', `${key} misdetected as ${result.encoding}`);
    assert.notEqual(result.encoding, 'binary');
  }
});

test('detect-file: pure ASCII is reported as UTF-8 but with lower confidence', () => {
  const result = detectFileEncoding(Buffer.from(CORRECT.ascii, 'ascii'));
  assert.equal(result.encoding, 'utf8');
  assert.ok(result.confidence < 0.8, `ASCII is ambiguous, got confidence ${result.confidence}`);
  assert.match(result.reason, /could be latin1|indistinguishable/);
});

test('detect-file: Latin-1 text is identified as latin1', () => {
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xfc, 0x74, 0x61, 0x6e]);
  const result = detectFileEncoding(latin1);
  assert.equal(result.encoding, 'latin1');
  assert.equal(result.utf8Valid, false);
  assert.match(result.reason, /not valid UTF-8/);
});

test('detect-file: windows-1252 text with the euro sign is latin1, not UTF-8', () => {
  const cp1252 = Buffer.from([0x50, 0x72, 0x69, 0x73, 0x3a, 0x20, 0x80, 0x20, 0x41]);
  const result = detectFileEncoding(cp1252);
  assert.equal(result.encoding, 'latin1', '0x80 is not a valid UTF-8 lead byte');
});

test('detect-file: binary data is reported as binary', () => {
  const pngish = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);
  assert.equal(detectFileEncoding(pngish).encoding, 'binary');
  assert.equal(detectFileEncoding(Buffer.alloc(64)).encoding, 'binary');
});

test('detect-file: an empty buffer reports no evidence rather than guessing', () => {
  const result = detectFileEncoding(Buffer.alloc(0));
  assert.equal(result.size, 0);
  assert.equal(result.confidence, 0, 'no evidence means no confidence');
  assert.match(result.reason, /empty/);
});

test('detect-file: malformed UTF-8 is rejected, not silently accepted', () => {
  const cases = [
    // 0xC0/0xC1 could only begin an overlong encoding, so they are rejected as
    // invalid leads before any length check is reached.
    [[0xc0, 0xaf], /invalid UTF-8 lead/],
    [[0xc1, 0x81], /invalid UTF-8 lead/],
    [[0xed, 0xa0, 0x80], /surrogate/], // UTF-8 encoded surrogate
    [[0xe2, 0x82], /truncated/], // incomplete 3-byte sequence
    [[0xf8, 0x88, 0x80, 0x80], /invalid UTF-8 lead/], // 5-byte sequence
    [[0xc0, 0x80], /invalid UTF-8 lead/], // NUL encoded overlong
    [[0x80], /invalid UTF-8 lead/], // stray continuation byte
  ];
  for (const [bytes, pattern] of cases) {
    const result = validateUtf8(Buffer.from(bytes));
    assert.equal(result.ok, false, `${bytes} should be invalid`);
    assert.match(result.error, pattern, `${bytes}: ${result.error}`);
  }
});

test('detect-file: well-formed UTF-8 validates, including boundaries', () => {
  for (const text of ['ascii', 'café', 'Привет', '€', '👋', '𝄞', '', '߿', '￿']) {
    const result = validateUtf8(Buffer.from(text, 'utf8'));
    assert.equal(result.ok, true, `${JSON.stringify(text)} should validate: ${result.error}`);
  }
});

test('detect-file: validateUtf8 respects a start offset (BOM skipping)', () => {
  const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('café', 'utf8')]);
  // U+FEFF is a real code point, so the BOM validates as UTF-8. The offset lets a
  // caller skip it and count only the payload.
  assert.equal(validateUtf8(buffer, 0).ok, true);
  assert.equal(validateUtf8(buffer, 3).ok, true);
  assert.equal(validateUtf8(buffer, 3).codeUnits, 4, 'the payload alone is 4 code units');
  assert.equal(validateUtf8(buffer, 0).codeUnits, 5, 'with the BOM it is 5');

  // Every offset inside "café" lands on a valid character boundary, because each
  // of these characters is a complete sequence. Only an offset landing in the
  // middle of a MULTI-byte sequence is invalid.
  assert.equal(validateUtf8(buffer, 4).ok, true);
  assert.equal(validateUtf8(buffer, 4).codeUnits, 3);

  // Offset 5 lands on the continuation byte of the "é" (C3 A9) with its lead
  // cut off, which must be rejected rather than silently skipped.
  const eAcute = Buffer.from('é', 'utf8');
  assert.deepEqual([...eAcute], [0xc3, 0xa9]);
  assert.equal(validateUtf8(eAcute, 0).ok, true);
  assert.equal(validateUtf8(eAcute, 1).ok, false, 'a lone continuation byte is invalid');
});

test('detect-file: nulRatio and nulsByParity are consistent', () => {
  const buffer = Buffer.from('Hi', 'utf16le');
  assert.equal(nulRatio(buffer), 0.5);
  const parity = nulsByParity(buffer);
  assert.equal(parity.even, 0);
  assert.equal(parity.odd, 2, 'UTF-16LE pads the odd offsets');
  assert.equal(nulRatio(Buffer.alloc(0)), 0);
});

test('detect-file: controlRatio ignores high bytes entirely', () => {
  // Regression: the control-byte ratio counted every UTF-8 continuation byte as a
  // control character, so ordinary Russian measured 43% "binary". At the character
  // level a UTF-8 file has no control bytes at all.
  for (const key of ['ru', 'fr', 'ja', 'emoji']) {
    const buffer = Buffer.from(CORRECT[key], 'utf8');
    assert.equal(controlRatio(buffer), 0, `${key} reported control characters at character level`);
  }
  const mixed = Buffer.from('a\u0001b');
  assert.ok(
    Math.abs(controlRatio(mixed) - 1 / 3) < 1e-12,
    'real control bytes are still counted'
  );
});

test('detect-file: binaryControlRatio counts only true control bytes', () => {
  // Its definition is "not printable and not DEL": control characters, C1 and NUL.
  // High bytes like 0x80-0xBF count as printable HERE too, which is why it is only
  // consulted after UTF-8 validation has already failed.
  const mixed = Buffer.from('a\u0001b');
  assert.ok(Math.abs(controlRatio(mixed) - 1 / 3) < 1e-12);
  assert.ok(Math.abs(binaryControlRatio(mixed) - 1 / 3) < 1e-12);
  assert.equal(binaryControlRatio(Buffer.from([0x00, 0x01, 0x02, 0x7f])), 1);
  assert.equal(binaryControlRatio(Buffer.from('plain text')), 0);
  assert.equal(binaryControlRatio(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 2 / 6);
});

test('detect-file: evaluateUtf16 rejects the wrong byte order for non-ASCII text', () => {
  // Regression: reading little-endian text as big-endian produces CJK Extension A
  // ("\u4800\u6500" style), which is ASSIGNED and used to count as plausible, so
  // both byte orders scored 1.0 and the decision fell back to NUL parity.
  const le = Buffer.from('Привет мир, это текст', 'utf16le');
  const asLE = evaluateUtf16(le, 'utf16le');
  const asBE = evaluateUtf16(le, 'utf16be');
  assert.ok(asLE.score > asBE.score, `LE ${asLE.score} must beat BE ${asBE.score}`);
  assert.ok(asBE.score < 1, `wrong byte order must not score a perfect ${asBE.score}`);

  // ASCII in UTF-16 is the hardest case: reading little-endian as big-endian
  // yields CJK Extension A ("\u4800\u6500"), which is assigned and looks
  // printable. Once that is counted implausible the text score alone resolves it,
  // with no help from NUL parity. Pinned because the parity tie-break still exists
  // as a fallback and this is what makes it unnecessary.
  const asciiLE = Buffer.from('Hello world, this is text', 'utf16le');
  const leScore = evaluateUtf16(asciiLE, 'utf16le').score;
  const beScore = evaluateUtf16(asciiLE, 'utf16be').score;
  assert.ok(leScore > beScore, `LE ${leScore} must beat BE ${beScore} on text plausibility alone`);
  assert.equal(detectFileEncoding(asciiLE).encoding, 'utf16le');
  assert.equal(detectFileEncoding(Buffer.from(asciiLE).swap16()).encoding, 'utf16be');

  // Short ASCII: even two characters are enough to separate the orders.
  assert.equal(detectFileEncoding(Buffer.from('Hi', 'utf16le')).encoding, 'utf16le');
  assert.equal(detectFileEncoding(Buffer.from('Hi', 'utf16le').swap16()).encoding, 'utf16be');
});

test('detect-file: never throws on hostile buffers', () => {
  const hostile = [
    Buffer.alloc(0),
    Buffer.of(0xff),
    Buffer.of(0xe2, 0x82),
    Buffer.of(0xed, 0xa0, 0x80),
    Buffer.alloc(1000, 0x00),
    Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d]), // ANSI colour
  ];
  for (const buffer of hostile) {
    assert.doesNotThrow(() => detectFileEncoding(buffer), buffer.toString('hex'));
    assert.doesNotThrow(() => decodeFile(buffer), buffer.toString('hex'));
  }
});

test('detect-file: accepts a Uint8Array as well as a Buffer', () => {
  const bytes = new Uint8Array(Buffer.from('café', 'utf8'));
  assert.equal(detectFileEncoding(bytes).encoding, 'utf8');
  assert.equal(decodeFile(bytes), 'café');
});

test('detect-file: the reported encoding is always one of the documented names', () => {
  const buffers = [
    Buffer.from('ascii'),
    Buffer.from('Привет', 'utf8'),
    Buffer.from('Hi', 'utf16le'),
    Buffer.from('Hi', 'utf16le').swap16(),
    Buffer.from([0xe9, 0xe8]),
    Buffer.alloc(16),
    Buffer.alloc(0),
  ];
  for (const buffer of buffers) {
    assert.ok(
      ENCODINGS.includes(detectFileEncoding(buffer).encoding),
      `undocumented encoding ${detectFileEncoding(buffer).encoding}`
    );
  }
});

test('detect-file: detection is deterministic', () => {
  const buffer = Buffer.from(CORRECT.ru, 'utf8');
  const first = JSON.stringify(detectFileEncoding(buffer));
  for (let i = 0; i < 10; i++) {
    assert.equal(JSON.stringify(detectFileEncoding(buffer)), first);
  }
});