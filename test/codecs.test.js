'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { CODECS, decode, encode, mojibake, normalizeCodec, unmangle } = require('../src/codecs.js');
const { CP1251, CP1252 } = require('../src/tables.js');

test('codecs: the accepted codec list is frozen', () => {
  assert.ok(Object.isFrozen(CODECS));
  assert.deepEqual(CODECS, ['latin1', 'cp1251', 'cp1252', 'utf8']);
});

test('codecs: normalizeCodec accepts the usual spellings', () => {
  const cases = [
    ['latin1', 'latin1'],
    ['latin-1', 'latin1'],
    ['ISO-8859-1', 'latin1'],
    ['iso8859-1', 'latin1'],
    ['binary', 'latin1'],
    ['cp1251', 'cp1251'],
    ['windows-1251', 'cp1251'],
    ['Win1251', 'cp1251'],
    ['1251', 'cp1251'],
    ['cp1252', 'cp1252'],
    ['windows-1252', 'cp1252'],
    ['utf8', 'utf8'],
    ['UTF-8', 'utf8'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeCodec(input), expected, `${input} -> ${expected}`);
  }
});

test('codecs: normalizeCodec rejects an unknown name loudly', () => {
  assert.throws(() => normalizeCodec('ebcdic'), RangeError);
  assert.throws(() => normalizeCodec('shift_jis'), /unknown encoding/);
});

test('codecs: decode matches TextDecoder for windows-1251 and windows-1252', () => {
  // Node's TextDecoder is the WHATWG reference implementation; our vendored
  // tables must agree with it byte for byte.
  for (const [name, table] of [['cp1251', CP1251], ['cp1252', CP1252]]) {
    const reference = new TextDecoder(`windows-${name.slice(2)}`, { fatal: false });
    for (let byte = 0; byte < 256; byte++) {
      assert.equal(
        decode(Buffer.of(byte), name),
        reference.decode(Uint8Array.of(byte)),
        `${name} byte 0x${byte.toString(16)}`
      );
    }
  }
});

test('codecs: latin1 decode is the identity over bytes', () => {
  for (let byte = 0; byte < 256; byte++) {
    assert.equal(decode(Buffer.of(byte), 'latin1'), String.fromCharCode(byte));
  }
});

test('codecs: encode then decode round-trips representable text', () => {
  const samples = {
    latin1: 'café naïve à côté',
    cp1251: 'Привет, мир! Как дела?',
    cp1252: 'Français: café, « oui », 10€',
    utf8: 'Привет 👋 café €',
  };
  for (const [codec, text] of Object.entries(samples)) {
    assert.equal(decode(encode(text, codec), codec), text, `${codec} round trip`);
  }
});

test('codecs: mojibake produces the classic broken forms', () => {
  // Expectations are DERIVED, not typed. A hand-written mojibake literal is
  // unreliable to transcribe and silently rots when the implementation changes;
  // deriving it from the codec table makes the assertion self-proving.
  assert.equal(mojibake('caf\u00e9', 'latin1'), 'caf\u00c3\u00a9');

  // For latin1, Node's own Buffer IS the reference: byte n -> U+00FF.
  const russian = '\u041f\u0440\u0438\u0432\u0435\u0442'; // "\u041f\u0440\u0438\u0432\u0435\u0442"
  assert.equal(
    mojibake(russian, 'latin1'),
    Buffer.from(russian, 'utf8').toString('latin1'),
    'latin1 mojibake matches Node\'s own latin1 decoding of the UTF-8 bytes'
  );

  // Each Cyrillic letter is 2 UTF-8 bytes, so 6 letters become 12 characters.
  assert.equal([...mojibake(russian, 'latin1')].length, 12);

  // For cp1251, build the expectation from the vendored WHATWG table.
  const viaTable = [...Buffer.from(russian, 'utf8')]
    .map((b) => String.fromCodePoint(CP1251[b]))
    .join('');
  assert.equal(mojibake(russian, 'cp1251'), viaTable);
  assert.notEqual(mojibake(russian, 'cp1251'), mojibake(russian, 'latin1'),
    'cp1251 and latin1 mojibake must differ for Cyrillic');
});

test('codecs: unmangle reverses mojibake for lossless cases', () => {
  for (const [text, codec] of [
    ['Français: café, naïf, à côté de l\'été.', 'latin1'],
    ['Привет, мир! Как дела?', 'latin1'],
    ['Français: Ça va très bien, garçon précis.', 'cp1252'],
    ['Привет, мир! Как дела?', 'cp1251'],
  ]) {
    assert.equal(unmangle(mojibake(text, codec), codec), text, `${codec} reverse`);
  }
});

test('codecs: encode is lossy by default and strict on request', () => {
  // Cyrillic has no ISO-8859-1 representation at all.
  const cyrillic = '\u041f\u0440\u0438\u0432\u0435\u0442';
  assert.doesNotThrow(() => encode(cyrillic, 'latin1'));
  assert.throws(() => encode(cyrillic, 'latin1', { strict: true }), RangeError);

  // The euro sign IS representable in windows-1251 (byte 0x88), so it is not a
  // valid strict-mode failure there. An emoji has no single-byte representation
  // in any codec, so it is the reliable example.
  const emoji = '\u{1f389}';
  assert.doesNotThrow(() => encode(emoji, 'cp1252'));
  assert.throws(() => encode(emoji, 'cp1252', { strict: true }), /not representable/);
  assert.throws(() => encode(emoji, 'cp1251', { strict: true }), /not representable/);
});

test('codecs: strict encode reports the offending code point', () => {
  // U+20AC (the euro sign) is byte 0x80 in windows-1252 and byte 0x88 in
  // windows-1251, so it encodes to BOTH. Emoji (U+1F389) is in no single-byte
  // codec at all, which makes it the reliable strict-mode failure.
  try {
    encode('a\u{1f389}b', 'cp1252', { strict: true });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof RangeError, `expected RangeError, got ${error}`);
    assert.match(error.message, /U\+1F389/i, 'names the offending code point');
    assert.match(error.message, /cp1252/, 'names the codec that cannot represent it');
  }
});

test('codecs: the euro sign is representable in both windows codepages', () => {
  // Pinned because it explains a real ranking decision: cp1252 and cp1251 both
  // cover U+20AC, so a document containing one is not narrowed down by it.
  assert.equal(CP1252[0x80], 0x20ac);
  assert.equal(CP1251[0x88], 0x20ac);
  assert.deepEqual(encode('\u20ac', 'cp1252'), Buffer.of([0x80]));
  assert.deepEqual(encode('\u20ac', 'cp1251'), Buffer.of([0x88]));
});

test('codecs: lossy encode substitutes a placeholder rather than dropping bytes', () => {
  // Length is preserved: dropping bytes would silently shift every later
  // character, which is far worse than a visible placeholder.
  const encoded = encode('a\u{1f389}b', 'cp1252');
  assert.equal(encoded.length, 3, 'byte count is preserved');
  assert.ok(encoded.includes(0x3f), 'unmappable characters become "?"');
  assert.equal(encoded[0], 0x61, 'the ASCII before it is untouched');
  assert.equal(encoded[2], 0x62, 'the ASCII after it is untouched');
});

test('codecs: a decode that cannot fail never throws', () => {
  for (const codec of CODECS) {
    for (const bytes of [[], [0], [0xff], [0x80, 0x81], [0xfe, 0xff, 0x00]]) {
      assert.doesNotThrow(() => decode(Buffer.from(bytes), codec), `${codec} ${bytes}`);
    }
  }
});

test('codecs: encode never throws without strict, whatever the input', () => {
  const hostile = ['', '\uD800', '🎉', 'ÿ'.repeat(100), '\u0000', String.fromCodePoint(0x10ffff)];
  for (const codec of CODECS) {
    for (const text of hostile) {
      assert.doesNotThrow(() => encode(text, codec), `${codec} ${JSON.stringify(text)}`);
    }
  }
});

test('codecs: control characters pass through every codec unchanged', () => {
  for (const codec of CODECS) {
    const buffer = encode('a\tb\nc\rd', codec);
    assert.equal(decode(buffer, codec), 'a\tb\nc\rd', `${codec} lost a control character`);
  }
});

test('codecs: a lone surrogate does not throw when encoded lossy', () => {
  assert.doesNotThrow(() => encode('\uD800', 'latin1'));
  assert.doesNotThrow(() => encode('\uD800', 'utf8'));
});

test('codecs: buffers of length 256 decode without throwing', () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  for (const codec of CODECS) {
    assert.doesNotThrow(() => decode(all, codec), codec);
  }
});