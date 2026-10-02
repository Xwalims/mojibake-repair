#!/usr/bin/env node
'use strict';

// The exit code MUST be assigned to process.exitCode, and main() is async, so the
// promise must be awaited before assigning. Dropping either half makes every
// failure path -- usage errors, I/O errors, --require-change -- exit 0, which
// silently breaks every caller and every CI check built on this.

require('../src/cli.js')
  .main(process.argv.slice(2))
  .then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `mojibake: unexpected failure: ${error && error.stack ? error.stack : error}\n`
      );
      process.exitCode = 2;
    }
  );