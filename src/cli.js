'use strict';

// CLI.
//
//   mojibake [-i FILE] [-o FILE] [--detect-only] [--explain] [--encoding E]
//            [--min-score N] [--json] [--quiet] [--fail-on-change]
//            [--require-change] [--file-encoding] [--version] [--help]
//
// Reads stdin when no input file is given. The default action is DETECTION ONLY:
// the tool reports a verdict and does not modify the text. Repairing requires
// --repair, and writing to a file requires --output. A tool that rewrites text on
// sight is a tool that eventually destroys something, so both the change and the
// destination have to be asked for explicitly.
//
// EXIT CODES
//   0  success (including "detected, nothing changed")
//   1  --fail-on-change and the text WAS repaired
//   2  usage error, or an I/O error reading/writing a file
//   3  --require-change and nothing was broken enough to repair

const fs = require('fs');
const { DEFAULTS, ENCODINGS, repair } = require('./repair.js');
const { STRATEGIES, STRATEGY_IDS } = require('./candidates.js');
const { decodeFile, detectFileEncoding, ENCODINGS: FILE_ENCODINGS } = require('./detect-file.js');
const { SIGNAL_WEIGHTS, THRESHOLDS } = require('./detect.js');
const { DEFAULT_MIN_SCORE, WEIGHTS } = require('./score.js');

const { version } = require('../package.json');

/** Exit codes, named so the numbers are never written bare. */
const EXIT = Object.freeze({
  ok: 0,
  changed: 1,
  usage: 2,
  noChange: 3,
});

/** Every CLI option with its default, in one frozen object. */
const OPTION_DEFAULTS = Object.freeze({
  input: null,
  output: null,
  detectOnly: true,
  repair: false,
  explain: false,
  encoding: 'auto',
  minScore: DEFAULT_MIN_SCORE,
  json: false,
  quiet: false,
  failOnChange: false,
  requireChange: false,
  fileEncoding: null,
  help: false,
  version: false,
});

const USAGE = `mojibake ${version}

Detect and repair broken text encodings (mojibake) by hypothesising the original
encoding and ranking the candidates, never by guessing a single round trip.

USAGE
  mojibake [options]                 read stdin, report the verdict
  mojibake -i FILE [options]         read FILE
  mojibake -i FILE -o FILE --repair  repair and write to FILE

OPTIONS
  -i, --input FILE        read from FILE (default: stdin)
  -o, --output FILE       write result to FILE (default: stdout)
      --repair            actually repair the text (default: detect only)
      --detect-only       force detection only, even if --repair was implied
      --explain           print every candidate with its score
      --encoding NAME     assume the misdecoding was NAME
                          (${ENCODINGS.join('|')}; default auto = try all)
      --min-score N       confidence threshold, 0..1 (default ${DEFAULT_MIN_SCORE})
      --file-encoding NAME  decode the input file as NAME
                          (${FILE_ENCODINGS.join('|')}; default: sniff)
      --json              machine-readable output
      --quiet             suppress the human-readable report
      --fail-on-change     exit 1 if the text was repaired
      --require-change     exit 3 if no repair was made
      --version           print the version
  -h, --help              print this help

EXIT CODES
  0  ok            1  repaired and --fail-on-change
  2  usage / I/O   3  --require-change and nothing was repaired

Detection only is the default. Correct text is never modified: when no candidate
beats the confidence threshold the original text is returned unchanged and the
tool says so.`;

/**
 * Parse argv.
 *
 * Supports `--opt value`, `--opt=value` and short flags. Never throws: returns
 * `{ ok: false, error }` so the caller can print usage and exit 2.
 *
 * @param {readonly string[]} argv
 * @returns {{ ok: boolean, options?: object, error?: string }}
 */
function parseArgs(argv) {
  const options = Object.assign({}, OPTION_DEFAULTS);
  const args = [...argv];

  const need = (flag, value) => {
    if (value === undefined) return `${flag} requires a value`;
    return null;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let name = arg;
    let inlineValue;

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        name = arg.slice(0, eq);
        inlineValue = arg.slice(eq + 1);
      }
    }

    const value = inlineValue !== undefined ? inlineValue : args[i + 1];
    const consumed = () => {
      if (inlineValue === undefined) i++;
    };

    switch (name) {
      case '-i':
      case '--input': {
        const err = need(name, value);
        if (err) return { ok: false, error: err };
        options.input = value;
        consumed();
        break;
      }
      case '-o':
      case '--output': {
        const err = need(name, value);
        if (err) return { ok: false, error: err };
        options.output = value;
        consumed();
        break;
      }
      case '--encoding': {
        const err = need(name, value);
        if (err) return { ok: false, error: err };
        if (!ENCODINGS.includes(value)) {
          return { ok: false, error: `unknown --encoding ${JSON.stringify(value)}; expected one of: ${ENCODINGS.join(', ')}` };
        }
        options.encoding = value;
        consumed();
        break;
      }
      case '--file-encoding': {
        const err = need(name, value);
        if (err) return { ok: false, error: err };
        if (!FILE_ENCODINGS.includes(value)) {
          return { ok: false, error: `unknown --file-encoding ${JSON.stringify(value)}; expected one of: ${FILE_ENCODINGS.join(', ')}` };
        }
        options.fileEncoding = value;
        consumed();
        break;
      }
      case '--min-score': {
        const err = need(name, value);
        if (err) return { ok: false, error: err };
        // Number('') is 0, which is finite and in range, so an empty value would
        // silently select the MOST permissive threshold. Reject it explicitly.
        if (value.trim() === '') {
          return { ok: false, error: '--min-score requires a value between 0 and 1' };
        }
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          return { ok: false, error: `--min-score must be a number between 0 and 1, got ${JSON.stringify(value)}` };
        }
        options.minScore = n;
        consumed();
        break;
      }
      case '--repair':
        options.repair = true;
        options.detectOnly = false;
        break;
      case '--detect-only':
        options.detectOnly = true;
        options.repair = false;
        break;
      case '--explain':
        options.explain = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--fail-on-change':
        options.failOnChange = true;
        break;
      case '--require-change':
        options.requireChange = true;
        break;
      case '--version':
      case '-V':
        options.version = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        // A bare argument is treated as the input file, so `mojibake file.txt`
        // works; anything else starting with a dash is a usage error.
        if (arg.startsWith('-') && arg !== '-') {
          return { ok: false, error: `unknown option ${JSON.stringify(arg)}` };
        }
        if (options.input === null) options.input = arg;
        else return { ok: false, error: `unexpected extra argument ${JSON.stringify(arg)}` };
    }
  }

  return { ok: true, options };
}

/**
 * Read the entire input as a Buffer, from a file or stdin.
 * @param {string|null} path
 * @returns {Promise<Buffer>}
 */
function readInput(path) {
  if (path === null) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
      process.stdin.on('error', reject);
    });
  }
  return fs.promises.readFile(path);
}

/**
 * Human-readable report.
 * @param {object} result from repair()
 * @param {object} options
 * @param {object|null} fileInfo from detectFileEncoding
 * @returns {string}
 */
function formatReport(result, options, fileInfo) {
  const lines = [];
  const source = options.input === null ? '<stdin>' : options.input;

  lines.push(`input: ${source}`);
  if (fileInfo) {
    lines.push(
      `file encoding: ${fileInfo.encoding} (confidence ${fileInfo.confidence}${
        fileInfo.bom ? `, BOM ${fileInfo.bom}` : ''
      }) -- ${fileInfo.reason}`
    );
  }
  lines.push(`detected: ${result.detection.broken ? 'BROKEN' : 'clean'} (score ${result.detection.score})`);
  lines.push(`signals: ${result.detection.signals.length ? result.detection.signals.join(', ') : 'none'}`);
  lines.push(`why: ${result.detection.reason}`);
  lines.push(`action: ${options.repair && !options.detectOnly ? 'repair' : 'detect only'}`);

  if (result.changed) {
    lines.push(`repaired: yes, as ${result.encoding} (score ${result.best.score.toFixed(3)})`);
  } else {
    lines.push('repaired: no');
    lines.push(`reason: ${result.reason}`);
  }

  if (options.explain) {
    lines.push('');
    // In detect-only mode nothing is repaired, so `best` is null and no candidate
    // would be marked. The top-ranked candidate is still the tool's opinion of
    // which hypothesis it would choose, so that is what gets marked -- and the
    // header says so, rather than implying a repair happened.
    const leader = result.best || result.candidates.find((c) => c.value !== null) || null;
    lines.push(
      result.best
        ? 'candidates (ranked, * = chosen):'
        : 'candidates (ranked, * = best hypothesis if repaired):'
    );
    for (const c of result.candidates) {
      const mark = c === leader ? '*' : ' ';
      const head = `${mark} ${c.id.padEnd(16)} ${c.score.toFixed(3)}`;
      lines.push(`  ${head}  ${c.reason}`);
      if (c.parts) {
        lines.push(
          `      printable=${(c.parts.printable * 100).toFixed(0)}% ` +
            `script=${c.parts.dominantScript || 'none'}:${(c.parts.consistency * 100).toFixed(0)}% ` +
            `artefacts=${c.parts.artefactCount} ` +
            `replacementChars=${c.parts.replacementChars}` +
            (c.parts.hints.length ? ` hints=${c.parts.hints.join(',')}` : '')
        );
      }
      if (c.value !== null) {
        const preview = c.value.length > 60 ? `${c.value.slice(0, 60)}...` : c.value;
        lines.push(`      value: ${JSON.stringify(preview)}`);
      }
      lines.push(`      what: ${c.note}`);
    }
  }

  if (options.repair && !options.detectOnly) {
    lines.push('');
    lines.push('--- repaired text ---');
    lines.push(result.value);
  }

  return lines.join('\n');
}

/**
 * Machine-readable output. Contains everything a caller needs to make its own
 * decision, including the original text so nothing is unrecoverable.
 * @param {object} result
 * @param {object} options
 * @param {object|null} fileInfo
 * @returns {string}
 */
function formatJson(result, options, fileInfo) {
  return JSON.stringify(
    {
      input: options.input,
      fileEncoding: fileInfo
        ? {
            encoding: fileInfo.encoding,
            bom: fileInfo.bom,
            confidence: fileInfo.confidence,
            reason: fileInfo.reason,
          }
        : null,
      detection: {
        broken: result.detection.broken,
        score: result.detection.score,
        signals: result.detection.signals,
        reason: result.detection.reason,
      },
      changed: result.changed,
      confident: result.confident,
      encoding: result.encoding,
      reason: result.reason,
      value: result.value,
      original: result.original,
      candidates: result.candidates.map((c) => ({
        encoding: c.assumed,
        id: c.id,
        score: c.score,
        changed: c.changed,
        eligible: c.eligible,
        aboveThreshold: c.aboveThreshold,
        error: c.error,
        value: c.value,
        reason: c.reason,
      })),
      thresholds: {
        minScore: options.minScore,
        suspect: THRESHOLDS.suspect,
        repairDefault: DEFAULTS.minScore,
      },
    },
    null,
    2
  );
}

/**
 * Entry point.
 *
 * Returns a process exit code rather than calling process.exit, so it stays
 * testable; bin/mojibake.js assigns the result to process.exitCode.
 *
 * @param {readonly string[]} argv arguments after the node binary and script
 * @returns {Promise<number>} exit code
 */
async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`mojibake: ${parsed.error}\n\n${USAGE}\n`);
    return EXIT.usage;
  }
  const options = parsed.options;

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }
  if (options.version) {
    process.stdout.write(`${version}\n`);
    return EXIT.ok;
  }

  let buffer;
  try {
    buffer = await readInput(options.input);
  } catch (error) {
    process.stderr.write(`mojibake: cannot read ${options.input}: ${error.message}\n`);
    return EXIT.usage;
  }

  const sniffed = detectFileEncoding(buffer);
  let text;
  try {
    text = decodeFile(buffer, options.fileEncoding || sniffed.encoding);
  } catch (error) {
    process.stderr.write(`mojibake: cannot decode input: ${error.message}\n`);
    return EXIT.usage;
  }
  const fileInfo = sniffed;

  const result = repair(text, {
    minScore: options.minScore,
    encoding: options.encoding,
    detectOnly: options.detectOnly,
  });

  // Whether the tool is being asked to change the text, used for output routing.
  const repairing = options.repair && !options.detectOnly;

  if (options.requireChange && !result.changed) {
    if (!options.quiet) {
      process.stderr.write(
        `mojibake: --require-change but nothing was repaired: ${result.reason}\n`
      );
    }
    return EXIT.noChange;
  }

  // Output routing. Two independent decisions, in this order:
  //
  //   1. An output file, if asked for, is ALWAYS written -- before any early
  //      return, so `--json -o FILE` writes the file and reports on stdout.
  //   2. What goes on stdout:
  //        --json           machine report, always. Highest priority, so a
  //                        scripted caller never parses the repaired text by
  //                        accident.
  //        --repair, piped  ONLY the repaired text, so the tool works as a
  //                        filter: mojibake --repair < in > out
  //        otherwise        the human report, which already contains the
  //                        repaired text when there was one
  //
  // In detection mode the text is never emitted, so a detection run can never
  // clobber a pipeline by accident.
  if (options.output) {
    try {
      await fs.promises.writeFile(options.output, result.value, 'utf8');
    } catch (error) {
      process.stderr.write(`mojibake: cannot write ${options.output}: ${error.message}\n`);
      return EXIT.usage;
    }
  }

  if (options.quiet) {
    // Nothing on stdout. Exit codes still apply.
  } else if (options.json) {
    process.stdout.write(`${formatJson(result, options, fileInfo)}\n`);
  } else if (repairing && !options.output && !process.stdout.isTTY) {
    // Piped and repairing: emit just the text, so the output can be redirected.
    process.stdout.write(result.value.endsWith('\n') ? result.value : `${result.value}\n`);
  } else {
    process.stdout.write(`${formatReport(result, options, fileInfo)}\n`);
  }

  if (options.failOnChange && result.changed) return EXIT.changed;
  return EXIT.ok;
}

module.exports = Object.freeze({
  EXIT,
  OPTION_DEFAULTS,
  STRATEGIES,
  STRATEGY_IDS,
  USAGE,
  formatJson,
  formatReport,
  main,
  parseArgs,
});