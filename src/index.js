'use strict';

// Public API. The CLI in src/cli.js is the user-facing surface; this is the
// programmatic one.

const { repair, repairMixed, detect, DEFAULTS, ENCODINGS } = require('./repair.js');
const { looksMojibake, analyse, measure, THRESHOLDS } = require('./detect.js');
const { detectFileEncoding, decodeFile } = require('./detect-file.js');
const {
  generateCandidates,
  STRATEGIES,
  STRATEGY_IDS,
} = require('./candidates.js');
const { rankCandidates, scoreCandidate, WEIGHTS } = require('./score.js');
const codecs = require('./codecs.js');

module.exports = Object.freeze({
  DEFAULTS,
  ENCODINGS,
  STRATEGIES,
  STRATEGY_IDS,
  THRESHOLDS,
  WEIGHTS,
  analyse,
  codecs,
  decodeFile,
  detect,
  detectFileEncoding,
  generateCandidates,
  looksMojibake,
  measure,
  rankCandidates,
  repair,
  repairMixed,
  scoreCandidate,
});