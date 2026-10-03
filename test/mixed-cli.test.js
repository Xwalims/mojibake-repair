'use strict';

/**
 * End-to-end tests for `--mixed`, spawning the REAL bin/mojibake.js.
 *
 * Why this file exists: `test/repair-mixed.test.js` pins `repairMixed()` as a
 * LIBRARY function and passed 14/14 while every reporting path of the flag was
 * broken. `mojibake --mixed --json` died with
 * `TypeError: Cannot read properties of undefined (reading 'broken')`, and so did
 * `--mixed -o FILE` and `--mixed --detect-only`. The library was correct; only
 * the code that printed its result assumed the single-hypothesis shape.
 *
 * So the contract these tests pin is: whatever `repairMixed()` returns, every
 * output route the CLI offers must survive it. A new flag that adds a new result
 * shape has to come through this file too, not just the library suite.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { mojibake } = require('../src/codecs.js');
const { EXIT } = require('../src/cli.js');

const BIN = path.join(__dirname, '..', 'bin', 'mojibake.js');

const FR = 'Français: déjà vu, où est la crème?';
const RU = 'Привет, мир! Это русский текст.';
const DE = 'Größe, Straße, weiß';

// A document that genuinely broke through two codecs: no single hypothesis can
// repair it, which is the whole reason --mixed exists.
const MIXED_BROKEN = [mojibake(FR, 'latin1'), mojibake(RU, 'cp1251'), mojibake(DE, 'latin1')].join('\n') + '\n';
const MIXED_CORRECT = `${FR}\n${RU}\n${DE}\n`;

/** @returns {{status: number, stdout: string, stderr: string}} */
function run(args = [], stdin = '') {
  const r = spawnSync(process.execPath, [BIN, ...args], { input: stdin, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function tempFile(content, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mojibake-mixed-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return { dir, path: p };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mojibake-mixed-'));
}

// ------------------------------------------------------------- the crash class
//
// Each of these exited 2 with a TypeError before the formatter was taught the
// mixed shape. They are grouped because the failure is identical in all three:
// a result field the printer assumed and the mixed path does not provide.

test('--mixed --json produces valid JSON and exits 0', () => {
  const r = run(['--mixed', '--json'], MIXED_BROKEN);
  assert.equal(r.status, EXIT.ok, `stderr was: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /TypeError/, 'the mixed result must not crash the printer');
  let report;
  assert.doesNotThrow(() => {
    report = JSON.parse(r.stdout);
  }, 'stdout was not valid JSON');
  assert.equal(report.mixed, true);
  assert.equal(report.changed, true);
  assert.equal(report.value, MIXED_CORRECT);
  assert.equal(report.original, MIXED_BROKEN);
});

test('--mixed --json keeps the shape a caller can read unconditionally', () => {
  // A caller doing `report.detection.broken` must not have to special-case
  // --mixed; the keys are present with an honest null rather than missing.
  const report = JSON.parse(run(['--mixed', '--json'], MIXED_BROKEN).stdout);
  for (const key of [
    'input', 'fileEncoding', 'mixed', 'changed', 'confident', 'encoding',
    'reason', 'value', 'original', 'candidates', 'segments',
    'repairedSegments', 'refusedSegments',
  ]) {
    assert.ok(key in report, `--mixed --json is missing the key ${key}`);
  }
  // There is no single encoding for a mixed document, so it must say null
  // rather than claim the first segment's codec won the whole file.
  assert.equal(report.encoding, null);
  assert.deepEqual(report.candidates, []);
  assert.equal(report.confident, true, 'every segment was repaired, so the run was confident');
});

test('--mixed --json reports each segment with its own codec', () => {
  const report = JSON.parse(run(['--mixed', '--json'], MIXED_BROKEN).stdout);
  assert.equal(report.segments.length, 3);
  const used = report.segments.map((s) => s.encoding);
  assert.ok(used.includes('cp1251'), `expected cp1251 for the Russian line, got ${JSON.stringify(used)}`);
  assert.equal(report.repairedSegments, 3);
  assert.equal(report.refusedSegments, 0);
});

test('--mixed -o FILE writes the repaired text and still reports', () => {
  const { dir, path: input } = tempFile(MIXED_BROKEN, 'in.txt');
  const out = path.join(dir, 'out.txt');
  const r = run(['-i', input, '--mixed', '-o', out]);
  try {
    assert.equal(r.status, EXIT.ok, `stderr was: ${r.stderr}`);
    assert.equal(fs.readFileSync(out, 'utf8'), MIXED_CORRECT);
    // -o writes the file AND the report goes to stdout; both are contractual.
    assert.match(r.stdout, /segments: 3/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--mixed --detect-only exits 0 and reports the per-segment verdict', () => {
  const r = run(['--mixed', '--detect-only'], MIXED_BROKEN);
  assert.equal(r.status, EXIT.ok, `stderr was: ${r.stderr}`);
  assert.match(r.stdout, /action: detect only/);
  assert.match(r.stdout, /segments: 3/);
});

// --------------------------------------------- --detect-only must change nothing

test('--mixed --detect-only does not emit the repaired text on stdout', () => {
  // --detect-only's contract across the whole tool: "Detection never emits the
  // text". A flag that leaks the repaired bytes through a new code path breaks
  // pipelines that treat stdout as a report.
  const r = run(['--mixed', '--detect-only'], MIXED_BROKEN);
  assert.doesNotMatch(r.stdout, /Привет/, 'repaired text must not appear in a detect-only report');
  assert.match(r.stdout, /cp1251/, 'but the per-segment verdict must be reported');
});

test('--mixed --detect-only -o FILE leaves the output byte-identical', () => {
  // The regression that mattered most: repairMixed() forced detectOnly off, so
  // this combination wrote REPAIRED text to a file while the report said
  // "text unchanged". Writing a file is the one path that cannot be taken back.
  const { dir, path: input } = tempFile(MIXED_BROKEN, 'in.txt');
  const out = path.join(dir, 'out.txt');
  const r = run(['-i', input, '--mixed', '--detect-only', '-o', out]);
  try {
    assert.equal(r.status, EXIT.ok, `stderr was: ${r.stderr}`);
    assert.equal(
      fs.readFileSync(out, 'utf8'),
      MIXED_BROKEN,
      '--detect-only must write the input unchanged, not the repair'
    );
    assert.doesNotMatch(r.stdout, /repaired: yes/, 'the report must not claim a repair happened');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--mixed --detect-only --json reports would-repair and changed false', () => {
  const report = JSON.parse(run(['--mixed', '--detect-only', '--json'], MIXED_BROKEN).stdout);
  assert.equal(report.changed, false);
  assert.equal(report.value, MIXED_BROKEN, 'value must be the input in detect-only mode');
  assert.equal(report.repairedSegments, 3, 'but the decision is still reported');
  assert.match(report.reason, /would repair 3 of 3/);
  assert.match(report.reason, /text unchanged/);
});

test('--mixed --detect-only does not trip --fail-on-change', () => {
  // If changed were true in detect-only mode, --fail-on-change would exit 1 for
  // a run that changed nothing -- the exact false alarm CI cannot distinguish
  // from a real regression.
  const r = run(['--mixed', '--detect-only', '--fail-on-change'], MIXED_BROKEN);
  assert.equal(r.status, EXIT.ok, `exit was ${r.status}, stderr: ${r.stderr}`);
});

// ------------------------------------------------------------- exit code routes

test('--mixed --fail-on-change exits 1 when it repaired something', () => {
  const r = run(['--mixed', '--fail-on-change'], MIXED_BROKEN);
  assert.equal(r.status, EXIT.changed);
});

test('--mixed --require-change exits 0 when segments were repaired', () => {
  const r = run(['--mixed', '--require-change'], MIXED_BROKEN);
  assert.equal(r.status, EXIT.ok);
});

test('--mixed --require-change exits 3 on input nothing can repair', () => {
  const r = run(['--mixed', '--require-change'], 'plain ascii\n');
  assert.equal(r.status, EXIT.noChange, `stderr was: ${r.stderr}`);
});

test('--mixed --quiet prints nothing at all', () => {
  const r = run(['--mixed', '--quiet'], MIXED_BROKEN);
  assert.equal(r.status, EXIT.ok);
  assert.equal(r.stdout, '');
});

// -------------------------------------------------- --mixed is additive, not a fix

test('without --mixed the same document is still refused byte-identical', () => {
  // The guard against "fixing" mixed documents by loosening repair(). If this
  // ever changes, the whole-document refusal the tool documents is gone.
  const r = run(['--repair'], MIXED_BROKEN);
  assert.equal(r.status, EXIT.ok);
  assert.equal(r.stdout, MIXED_BROKEN, 'the default path must still refuse');
});

test('--mixed on a single-codec document matches the whole-document repair', () => {
  const broken = mojibake(RU, 'cp1251') + '\n';
  const viaMixed = run(['--mixed'], broken).stdout;
  const viaRepair = run(['--repair'], broken).stdout;
  assert.equal(viaMixed, viaRepair);
});

test('--mixed on already-correct text leaves it alone', () => {
  const r = run(['--mixed', '--json'], MIXED_CORRECT);
  const report = JSON.parse(r.stdout);
  assert.equal(report.changed, false);
  assert.equal(report.value, MIXED_CORRECT);
});

test('--mixed on pure ASCII reports unchanged', () => {
  const ascii = 'hello\nworld\n';
  const report = JSON.parse(run(['--mixed', '--json'], ascii).stdout);
  assert.equal(report.changed, false);
  assert.equal(report.value, ascii);
});

test('--mixed --explain exits 0 rather than printing a candidate ranking', () => {
  // There is no candidate ranking for a per-segment decision; the report gives
  // the segment list instead. It must not fall through to the single-hypothesis
  // explain path and crash on a missing `best`.
  //
  // Piped and repairing, the CLI emits ONLY the repaired text (that is the
  // filter contract every mode shares), so the report itself is checked through
  // -o, where stdout carries it.
  const piped = run(['--mixed', '--explain'], MIXED_BROKEN);
  assert.equal(piped.status, EXIT.ok, `stderr was: ${piped.stderr}`);
  assert.doesNotMatch(piped.stderr, /TypeError/);
  assert.equal(piped.stdout, MIXED_CORRECT, 'piped --mixed --explain still emits just the text');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mojibake-mixed-'));
  try {
    const input = path.join(dir, 'in.txt');
    fs.writeFileSync(input, MIXED_BROKEN, 'utf8');
    const r = run(['-i', input, '--mixed', '--explain', '-o', path.join(dir, 'out.txt')]);
    assert.equal(r.status, EXIT.ok, `stderr was: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /TypeError/);
    assert.match(r.stdout, /segments: 3/);
    // The whole-document explain prints a ranked candidate list; the mixed
    // report must not pretend one exists.
    assert.doesNotMatch(r.stdout, /candidates \(ranked/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--mixed preserves CRLF through a repair', () => {
  const broken = [mojibake(FR, 'latin1'), mojibake(RU, 'cp1251')].join('\r\n') + '\r\n';
  const r = run(['--mixed'], broken);
  assert.equal(r.status, EXIT.ok, `stderr was: ${r.stderr}`);
  assert.equal(r.stdout, `${FR}\r\n${RU}\r\n`);
  assert.ok(!/[^\r]\n/.test(r.stdout), 'no bare LF may survive');
});

test('an unknown flag next to --mixed is still a usage error', () => {
  const r = run(['--mixed', '--nope'], MIXED_BROKEN);
  assert.equal(r.status, EXIT.usage);
  assert.match(r.stderr, /unknown option/);
});

test('--mixed appears in --help and the README documents it', () => {
  // Direction 4 of the flag contract: a working flag the README never mentions
  // is a shipped feature nobody can find. --mixed shipped undocumented.
  const help = run(['--help']).stdout;
  assert.match(help, /--mixed/, '--mixed must be in --help');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /--mixed/, 'README must document --mixed');
});

test('every --mixed output route exits 0 on a file-backed mixed document', () => {
  // Sweeps the routes with the real file input rather than stdin, since -o and
  // the file sniffer only engage there.
  const { dir, path: input } = tempFile(MIXED_BROKEN, 'in.txt');
  try {
    for (const args of [
      ['--mixed'],
      ['--mixed', '--json'],
      ['--mixed', '--explain'],
      ['--mixed', '--detect-only'],
      ['--mixed', '--detect-only', '--json'],
      ['--mixed', '--quiet'],
    ]) {
      const r = run(['-i', input, ...args]);
      assert.equal(r.status, EXIT.ok, `mojibake ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /TypeError|unexpected failure/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});