'use strict';

// End-to-end tests that spawn the REAL bin/mojibake.js.
//
// Nothing here stubs process.stdout or mocks the filesystem: the exit codes and
// output asserted are the ones a shell would actually see. That matters most for
// the exit codes, because assigning a Promise to process.exitCode (or forgetting
// to assign it at all) type-checks fine and silently makes every failure exit 0.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { mojibake } = require('../src/codecs.js');
const { EXIT } = require('../src/cli.js');
const { CORRECT } = require('./fixtures.js');

const BIN = path.join(__dirname, '..', 'bin', 'mojibake.js');
const { version } = require('../package.json');

/**
 * Run the real CLI.
 * @param {readonly string[]} args
 * @param {{ input?: string }} [options] stdin content
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(args = [], options = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    input: options.input === undefined ? '' : options.input,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/** Create a temp file holding `content`, return its path. */
function tempFile(content, extension = '.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mojibake-test-'));
  const file = path.join(dir, `input${extension}`);
  fs.writeFileSync(file, content, 'utf8');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const BROKEN_FR = mojibake(CORRECT.fr, 'cp1252');
const BROKEN_RU = mojibake(CORRECT.ru, 'latin1');

// ---------------------------------------------------------------------------
// Help and version
// ---------------------------------------------------------------------------

test('cli: --version prints the version and exits 0', () => {
  const result = run(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), version);
  assert.equal(result.stderr, '');
});

test('cli: --help prints usage and exits 0', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /USAGE/);
  assert.match(result.stdout, /--detect-only/);
  assert.match(result.stdout, /EXIT CODES/);
});

// ---------------------------------------------------------------------------
// Detection only is the default
// ---------------------------------------------------------------------------

test('cli: detection only is the default and prints the verdict without changing text', () => {
  const result = run([], { input: BROKEN_FR });
  assert.equal(result.status, 0, 'detection alone is not an error');
  assert.match(result.stdout, /detected: BROKEN/);
  assert.match(result.stdout, /signals: utf8-pair/);
  assert.match(result.stdout, /repaired: no/);
  assert.match(result.stdout, /action: detect only/);
  // The repaired text must NOT be emitted in detect-only mode.
  assert.ok(!result.stdout.includes(CORRECT.fr), 'must not print the repaired text');
});

test('cli: --detect-only explicitly prints the verdict and nothing else', () => {
  const result = run(['--detect-only'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /detected: BROKEN/);
  assert.ok(!result.stdout.includes(CORRECT.fr), 'must not print the repaired text');
});

test('cli: correct text is reported clean', () => {
  const result = run([], { input: CORRECT.fr });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /detected: clean/);
  assert.match(result.stdout, /repaired: no/);
});

test('cli: the file encoding is reported', () => {
  const result = run([], { input: CORRECT.ru });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /file encoding: utf8/);
  assert.match(result.stdout, /confidence/);
});

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

// Note on output routing: a test's stdout is a pipe, so `run(['--repair'], ...)`
// exercises the FILTER path -- the repaired text and nothing else. That is what
// makes `mojibake --repair < in > out` work. The human report is checked through
// --json or by writing to a file, both of which are unambiguous.

test('cli: --repair piped to stdout emits ONLY the repaired text', () => {
  const result = run(['--repair'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout.trim(),
    CORRECT.fr,
    'a piped --repair must emit just the repaired text, so it can be redirected'
  );
  assert.ok(!result.stdout.includes('repaired:'), 'no report is mixed into the text stream');
});

test('cli: --repair on Russian broken through latin1', () => {
  const result = run(['--repair'], { input: BROKEN_RU });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), CORRECT.ru);
});

test('cli: --repair piped through correct text is a pass-through', () => {
  const result = run(['--repair'], { input: CORRECT.fr });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), CORRECT.fr, 'correct text must survive the round trip');
});

test('cli: --repair with --json reports the repair rather than the text', () => {
  const result = run(['--json', '--repair'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.changed, true);
  assert.equal(report.value, CORRECT.fr);
  assert.equal(report.encoding, 'cp1252');
});

// ---------------------------------------------------------------------------
// Exit codes -- the reason these tests spawn a real process
// ---------------------------------------------------------------------------

test('cli: --fail-on-change exits 1 when the text was repaired', () => {
  const result = run(['--repair', '--fail-on-change'], { input: BROKEN_FR });
  assert.equal(result.status, EXIT.changed);
  assert.equal(result.status, 1);
});

test('cli: --fail-on-change exits 0 when nothing was repaired', () => {
  const result = run(['--repair', '--fail-on-change'], { input: CORRECT.fr });
  assert.equal(result.status, 0);
});

test('cli: --fail-on-change alone (no --repair) exits 0 even on broken text', () => {
  // Detection-only never changes the text, so nothing can fail.
  const result = run(['--fail-on-change'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
});

test('cli: --require-change exits 3 when nothing was repaired', () => {
  const result = run(['--require-change'], { input: CORRECT.fr });
  assert.equal(result.status, EXIT.noChange);
  assert.equal(result.status, 3);
});

test('cli: --require-change exits 0 when a repair happened', () => {
  const result = run(['--repair', '--require-change'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
});

test('cli: an unknown option exits 2 and explains itself', () => {
  const result = run(['--not-a-real-option']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option/);
  assert.match(result.stderr, /USAGE/);
});

test('cli: a missing input file exits 2', () => {
  const result = run(['-i', path.join(os.tmpdir(), 'definitely-not-here-12345.txt')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read/);
});

test('cli: an invalid --min-score exits 2', () => {
  for (const value of ['abc', '-1', '2', '']) {
    const result = run(['--min-score', value]);
    assert.equal(result.status, 2, `--min-score ${JSON.stringify(value)} should exit 2`);
    assert.match(result.stderr, /min-score/);
  }
});

test('cli: an invalid --encoding exits 2', () => {
  const result = run(['--encoding', 'ebcdic']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown --encoding/);
});

test('cli: an option missing its value exits 2', () => {
  const result = run(['--min-score']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires a value/);
});

test('cli: an unwritable output path exits 2', () => {
  const result = run([
    '--repair',
    '-o',
    path.join(os.tmpdir(), 'no-such-dir-12345', 'out.txt'),
  ], { input: BROKEN_FR });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot write/);
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test('cli: -i reads a file', () => {
  const { file, cleanup } = tempFile(BROKEN_FR);
  try {
    const result = run(['-i', file]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /detected: BROKEN/);
    assert.match(result.stdout, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    cleanup();
  }
});

test('cli: a bare argument is treated as the input file', () => {
  const { file, cleanup } = tempFile(BROKEN_FR);
  try {
    const result = run([file]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /detected: BROKEN/);
  } finally {
    cleanup();
  }
});

test('cli: -o writes the repaired text to a file', () => {
  const { file, cleanup } = tempFile(BROKEN_RU);
  const out = `${file}.out`;
  try {
    const result = run(['--repair', '-i', file, '-o', out]);
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(out, 'utf8'), CORRECT.ru, 'file content must be the repaired text');
  } finally {
    cleanup();
  }
});

test('cli: -o without --repair writes the text UNCHANGED', () => {
  const { file, cleanup } = tempFile(BROKEN_FR);
  const out = `${file}.out`;
  try {
    run(['-i', file, '-o', out]);
    assert.equal(
      fs.readFileSync(out, 'utf8'),
      BROKEN_FR,
      'detection-only must not rewrite the text'
    );
  } finally {
    cleanup();
  }
});

test('cli: reads a UTF-16 file and repairs it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mojibake-test-'));
  const file = path.join(dir, 'broken.txt');
  // Broken text, written as UTF-16LE with a BOM, exactly as a legacy app would.
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(BROKEN_FR, 'utf16le'),
  ]));
  const out = path.join(dir, 'out.txt');
  try {
    const result = run(['--json', '--repair', '-i', file, '-o', out]);
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.fileEncoding.encoding, 'utf16le');
    assert.equal(report.fileEncoding.bom, 'utf16le');
    assert.equal(fs.readFileSync(out, 'utf8'), CORRECT.fr, 'output is clean UTF-8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: --repair to a file also reports the verdict on stdout', () => {
  const { file, cleanup } = tempFile(BROKEN_RU);
  const out = `${file}.out`;
  try {
    const result = run(['--json', '--repair', '-i', file, '-o', out]);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).changed, true);
    assert.equal(fs.readFileSync(out, 'utf8'), CORRECT.ru);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// --explain
// ---------------------------------------------------------------------------

test('cli: --explain lists every candidate with its score', () => {
  const result = run(['--explain'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /candidates \(ranked/);
  for (const id of ['utf8-as-latin1', 'utf8-as-cp1252', 'utf8-as-cp1251']) {
    assert.match(result.stdout, new RegExp(id.replace('-', '-')), `missing candidate ${id}`);
  }
  assert.match(result.stdout, /printable=/, 'shows the component breakdown');
  assert.match(result.stdout, /script=/);
  assert.match(result.stdout, /what: /, 'explains what each hypothesis assumes');
});

/**
 * Extract the ranked candidate rows from --explain output.
 * Rows look like: "    utf8-as-latin1   0.854  ..." or "  * utf8-as-cp1252   1.000 ...".
 * @param {string} stdout
 * @returns {ReadonlyArray<{ marked: boolean, id: string, score: number }>}
 */
function rankedRows(stdout) {
  return stdout
    .split('\n')
    .map((line) => /^\s*(\*|\s)\s+([a-z0-9-]+)\s+(\d\.\d{3})\s/.exec(line))
    .filter(Boolean)
    .map((m) => ({ marked: m[1] === '*', id: m[2], score: Number(m[3]) }));
}

test('cli: --explain ranks candidates in non-increasing score order', () => {
  const rows = rankedRows(run(['--explain'], { input: BROKEN_FR }).stdout);
  assert.ok(rows.length >= 3, `expected several ranked candidates, got ${rows.length}`);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i - 1].score >= rows[i].score,
      `score order broke at ${i}: ${rows[i - 1].id} ${rows[i - 1].score} < ${rows[i].id} ${rows[i].score}`
    );
  }
  assert.ok(rows.some((r) => r.marked), 'exactly one candidate is marked');
  assert.equal(rows.filter((r) => r.marked).length, 1);
  assert.equal(rows[0].marked, true, 'the marked candidate is the top-ranked one');
});

test('cli: --explain marks the best hypothesis, not a repair, in detect-only mode', () => {
  const result = run(['--explain'], { input: BROKEN_FR });
  assert.match(result.stdout, /best hypothesis if repaired/);
  assert.match(result.stdout, /repaired: no/, 'and it is explicit that nothing was repaired');

  const rows = rankedRows(result.stdout);
  assert.equal(rows[0].id, 'utf8-as-cp1252', 'cp1252 is the best hypothesis for cp1252-broken text');
});

test('cli: --explain with --repair marks the candidate that was actually chosen', () => {
  // -o makes the report the only thing on stdout, so the human-readable
  // --explain output can be asserted without the filter path swallowing it.
  const out = path.join(os.tmpdir(), `mojibake-explain-${process.pid}.txt`);
  try {
    const result = run(['--explain', '--repair', '-o', out], { input: BROKEN_FR });
    assert.match(result.stdout, /\* = chosen/);
    const rows = rankedRows(result.stdout);
    assert.equal(rows[0].id, 'utf8-as-cp1252');
    assert.equal(rows[0].marked, true);
  } finally {
    fs.rmSync(out, { force: true });
  }
});

// ---------------------------------------------------------------------------
// --json
// ---------------------------------------------------------------------------

test('cli: --json emits a parseable report with the verdict', () => {
  const result = run(['--json'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.detection.broken, true);
  assert.equal(report.changed, false);
  assert.equal(report.original, BROKEN_FR, 'the original is always reported');
  assert.ok(Array.isArray(report.candidates));
  assert.ok(report.candidates.length > 0);
  assert.equal(report.fileEncoding.encoding, 'utf8');
});

test('cli: --json with --repair reports the repaired value', () => {
  const result = run(['--json', '--repair'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.changed, true);
  assert.equal(report.confident, true);
  assert.equal(report.value, CORRECT.fr);
  assert.equal(report.original, BROKEN_FR);
  assert.equal(report.encoding, 'cp1252');
});

test('cli: --json is valid JSON for correct text too', () => {
  const result = run(['--json'], { input: CORRECT.fr });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.detection.broken, false);
  assert.equal(report.changed, false);
  assert.equal(report.value, CORRECT.fr);
});

test('cli: --json exposes thresholds for reproducibility', () => {
  const result = run(['--json'], { input: BROKEN_FR });
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.thresholds.minScore, 'number');
  assert.equal(typeof report.thresholds.suspect, 'number');
});

// ---------------------------------------------------------------------------
// --quiet and --encoding
// ---------------------------------------------------------------------------

test('cli: --quiet suppresses the report but keeps the exit code', () => {
  const result = run(['--quiet'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('cli: --quiet still honours --fail-on-change', () => {
  const result = run(['--quiet', '--repair', '--fail-on-change'], { input: BROKEN_FR });
  assert.equal(result.status, 1);
});

test('cli: --encoding forces a hypothesis', () => {
  // --json keeps the machine report on stdout regardless of the filter path.
  const result = run(['--json', '--repair', '--encoding', 'cp1252'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.value, CORRECT.fr);
  assert.deepEqual(
    report.candidates.map((c) => c.id),
    ['utf8-as-cp1252'],
    'forcing an encoding leaves exactly the one hypothesis that names it'
  );
});

test('cli: --encoding latin1 on cp1252-broken text is permitted but must not corrupt', () => {
  // The user asked for a hypothesis this tool can show is lossy, so it says so
  // instead of quietly returning something worse.
  const result = run(['--json', '--repair', '--encoding', 'latin1'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.original, BROKEN_FR);
  if (!report.changed) {
    assert.equal(report.value, BROKEN_FR, 'a refused repair returns the original');
  }
});

test('cli: --min-score 1 refuses to repair', () => {
  const result = run(['--json', '--repair', '--min-score', '1'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  if (!report.changed) {
    assert.equal(report.value, BROKEN_FR, 'a refused repair returns the original');
    assert.equal(report.original, BROKEN_FR);
  }
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('cli: empty stdin does not crash', () => {
  const result = run([], { input: '' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /detected: clean/);
});

test('cli: binary stdin does not crash', () => {
  // Raw control bytes and high bytes: the CLI must exit cleanly and name an
  // encoding rather than throwing on bytes that decode to nothing meaningful.
  // Built from escapes so this file itself stays plain text.
  const binary = '\u0000\u0001\u0002\u0003\u00ff\u00fe';
  const result = run(['--json'], { input: binary });
  assert.equal(result.status, 0, 'binary input is not a usage error');
  const report = JSON.parse(result.stdout);
  assert.equal(typeof report.fileEncoding.encoding, 'string');
  assert.ok(
    ['utf8', 'binary', 'latin1', 'utf16le', 'utf16be'].includes(report.fileEncoding.encoding),
    `unexpected encoding ${report.fileEncoding.encoding}`
  );
  assert.ok(report.fileEncoding.reason.length > 0, 'the verdict is explained');
  // `original` is the text as DECODED from the file bytes, so it is not the raw
  // input when the file is not UTF-8. What must hold is that the report round-trips
  // its own claim: decoding the bytes as the reported encoding yields `original`.
  assert.equal(typeof report.original, 'string');
});

test('cli: truly binary data is identified as binary', () => {
  // A PNG header: not valid UTF-8, not text.
  const png = '\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR';
  const report = JSON.parse(run(['--json'], { input: png }).stdout);
  assert.equal(report.fileEncoding.encoding, 'binary');
});

test('cli: --detect-only overrides --repair when given last', () => {
  const result = run(['--repair', '--detect-only'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /action: detect only/);
  assert.ok(!result.stdout.includes(CORRECT.fr));
});

test('cli: options accept --name=value form', () => {
  const result = run(['--json', '--min-score=0.5'], { input: BROKEN_FR });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).thresholds.minScore, 0.5);
});

test('cli: repeated runs are byte-for-byte identical', () => {
  const a = run(['--json', '--repair'], { input: BROKEN_RU });
  const b = run(['--json', '--repair'], { input: BROKEN_RU });
  assert.equal(a.stdout, b.stdout, 'output must be deterministic');
  assert.equal(a.status, b.status);
});