# mojibake-repair

Detect and repair broken text encodings (mojibake) — by **hypothesising the
original encoding and ranking the candidates**, never by guessing a single round
trip. Zero dependencies, Node 20+.

This package is **not published to npm** — the name is unregistered, so
`npm install -g mojibake-repair` fails. Run it from a checkout:

```console
$ git clone https://github.com/Xwalims/mojibake-repair.git
$ cd mojibake-repair
$ node bin/mojibake.js --help
```

Or link it onto your `PATH`:

```console
$ npm link          # provides the `mojibake` command
```

---

## The problem this actually solves

Broken text is **not** fixed by "encode to latin1, then decode as utf8". That
heuristic is wrong in both directions, and the reasons are structural.

**It misses real breakage.** Russian UTF-8 read through windows-1251 — a legacy
Windows pipeline — comes out as clean-looking Cyrillic with *no byte-pair
structure at all*:

```
correct : Привет, мир! Как дела? Сегодня хорошая погода.
cp1251  : РџСЂРёРІРµС‚, РјРёРЂ! РљР°Рє РґРµР»Р°? РЎРµРіРѕРґРЅСЏ С…РѕСЂРѕСЂР°СЏ РїРѕРіРѕРґР°.
```

There is nothing byte-shaped about that. Every "look for accented characters"
rule misses it, and the latin1 round trip actively corrupts it. **This is why
detection and repair must be separate steps.**

**It breaks correct text.** Correct German contains `ß»` (`Maß»`); correct French
contains `ça`, `garçon`, `à côté`. Any rule that fires on the presence of a
suspicious character mangles valid text. Measured on a corpus of correct
European, Cyrillic, CJK, RTL, maths and emoji text, a single `ß»` in a German
sentence scores a *higher* artefact ratio than most genuinely broken samples.

So this tool does two things separately:

- **detect** — measure structural signals and report a score with a reason
- **repair** — generate every plausible hypothesis, score each independently,
  rank them, and use one only if it beats the confidence threshold

And the rule that matters most: **if nothing is trustworthy, the original text is
returned byte-identical with `confident: false`.** Refusing is a feature.

---

## What the breakage looks like

```
correct French : Français: café, naïf, à côté de l'été. Ça va très bien, garçon précis.
broken via cp1252: FranÃ§ais: cafÃ©, naÃ¯f, Ã  cÃ³tÃ© de l'Ã©tÃ©. Ã‡a va trÃ¨s bien, garÃ§on prÃ©cis.
correct Russian: Привет, мир! Как дела? Сегодня хорошая погода.
broken via latin1: ÐÑÐ¸Ð²ÐµÑ, Ð¼Ð¸Ñ! ÐÐ°Ðº Ð´ÐµÐ»Ð°? Ð¡РµРіРѕРґРЅСЏ С…РѕСЂРѕС�Р°СЏ РїРѕРіРѕРґР°.
broken via cp1251: РџСЂРёРІРµС‚, РјРёРЂ! РљР°Рє РґРµР»Р°? РЎРµРіРѕРґРЅСЏ С…РѕСЂРѕСЂР°СЏ РїРѕРіРѕРґР°.
```

---

## Usage

### Detect (the default — nothing is modified)

```
$ printf 'FranÃ§ais: cafÃ©, naÃ¯f, Ã  cÃ³tÃ©' | mojibake
```
```
input: <stdin>
file encoding: utf8 (confidence 0.9458) -- decodes as well-formed UTF-8 including non-ASCII bytes
detected: BROKEN (score 0.6)
signals: utf8-pair
why: 12 UTF-8 byte pairs (ratio 1.00 >= 0.5) -> broken encoding detected
action: detect only
repaired: no
reason: detected broken encoding (score 0.6); --detect-only, text unchanged
# exit 0
```

Correct text is reported clean, and importantly it is scored **exactly 0**, not
merely "low":

```
$ printf "Français: café, naïf, à côté de l'été." | mojibake
```
```
input: <stdin>
file encoding: utf8 (confidence 0.9293) -- decodes as well-formed UTF-8 including non-ASCII bytes
detected: clean (score 0)
signals: none
why: non-ASCII text with no mojibake signature
action: detect only
repaired: no
reason: no mojibake signature detected; text returned unchanged
# exit 0
```

### Repair

Piped, `--repair` emits **only** the repaired text, so the tool is a filter:

```
$ printf 'FranÃ§ais: cafÃ©, naÃ¯f' | mojibake --repair
```
```
Français: café, naïf, à côté de l'été. Ça va très bien, garçon précis.
# exit 0
```

### The cp1251 case, which has no byte-pair structure

```
$ printf 'РџСЂРёРІРµС‚, РјРёРЂ! РљР°Рє РґРµР»Р°?' | mojibake
```
```
input: <stdin>
file encoding: utf8 (confidence 0.99) -- decodes as well-formed UTF-8 including non-ASCII bytes
detected: BROKEN (score 0.45)
signals: cyrillic-extras
why: 25/61 Cyrillic letters are cp1251 padding (ratio 0.41 >= 0.26) -> broken encoding detected
action: detect only
repaired: no
reason: detected broken encoding (score 0.45); --detect-only, text unchanged
# exit 0
```

### Inspect the decision

`--explain` prints every candidate, its score and its reasoning, so the choice is
checkable rather than trusted:

```
$ printf 'FranÃ§ais: cafÃ©, naÃ¯f' | mojibake --explain
```
```
input: <stdin>
file encoding: utf8 (confidence 0.9458) -- decodes as well-formed UTF-8 including non-ASCII bytes
detected: BROKEN (score 0.6)
signals: utf8-pair
why: 12 UTF-8 byte pairs (ratio 1.00 >= 0.5) -> broken encoding detected
action: detect only
repaired: no
reason: detected broken encoding (score 0.6); --detect-only, text unchanged

candidates (ranked, * = best hypothesis if repaired):
  * utf8-as-cp1252   1.000  score 1.000, printable 100%, script Latin 100%, artefacts 0, hints fr,es,pt,nl
      printable=100% script=Latin:100% artefacts=0 replacementChars=0 hints=fr,es,pt,nl
      value: "Français: café, naïf, à côté de l'été. Ça va très bien, garç..."
      what: Identical to utf8-as-latin1 except that 0x80-0x9F decode to typographic punctuation (€, curly quotes, ellipsis). Right for Windows-produced text; only distinguishable from latin1 when those bytes actually occur.
    utf8-as-latin1   0.000  score 0.000, printable 100%, script Latin 100%, artefacts 0, hints fr,es,pt,cs,nl, DISQUALIFIED: 1 replacement chars
      printable=100% script=Latin:100% artefacts=0 replacementChars=1 hints=fr,es,pt,cs,nl
      value: "Français: café, naïf, à côté de l'été. �?a va très bien, gar..."
      what: The classic case: UTF-8 text read through latin1 by a mislabelled page, HTTP header or subprocess pipe. Each 2-byte UTF-8 sequence became 2 Latin-1 characters, so the repair re-encodes to latin1 and decodes as UTF-8.
    utf8-as-cp1251   0.000  score 0.000, printable 100%, script Latin 100%, artefacts 0, hints fr,es,pt,pl,cs,nl, DISQUALIFIED: 9 replacement chars
      printable=100% script=Latin:100% artefacts=0 replacementChars=9 hints=fr,es,pt,pl,cs,nl
      value: "Fran?�ais: caf?�, na??f, ?� c??t?� de l'?�t?�. ?�a va tr??s ..."
      what: Russian UTF-8 read through windows-1251. Produces clean-looking Cyrillic with no byte-pairing at all, which is why detection needs its own signal and why this candidate is generated even when pairing looks clean.
```

Note the disqualification: the latin1 hypothesis recovers `Ça` as `�?a`, because
byte `0x87` is defined in windows-1252 but not in ISO-8859-1. Losing a byte
disqualifies a candidate outright.

### Machine-readable

```
$ mojibake --json
```
```
{
  "detection": {
    "broken": true,
    "score": 0.6,
    "signals": [
      "utf8-pair"
    ],
    "reason": "12 UTF-8 byte pairs (ratio 1.00 >= 0.5) -> broken encoding detected"
  },
  "changed": false,
  "confident": false,
  "encoding": null,
  "reason": "detected broken encoding (score 0.6); --detect-only, text unchanged",
  "value": "FranÃ§ais: cafÃ©, naÃ¯f, Ã  cÃ´tÃ© de l'Ã©tÃ©. Ã‡a va trÃ¨s bien, garÃ§on prÃ©cis.",
  "original": "FranÃ§ais: cafÃ©, naÃ¯f, Ã  cÃ´tÃ© de l'Ã©tÃ©. Ã‡a va trÃ¨s bien, garÃ§on prÃ©cis."
}
```

### Exit codes

```
$ mojibake --repair --fail-on-change < broken.txt    # exits 1
$ mojibake --require-change < clean.txt             # exits 3
$ mojibake --not-a-flag                            # exits 2
```
```
Français: café, naïf, à côté de l'été. Ça va très bien, garçon précis.
# exit 1
mojibake: --require-change but nothing was repaired: no mojibake signature detected; text returned unchanged
# exit 3
mojibake: unknown option "--nope"
# exit 2
```

---

## CLI

```
mojibake [-i FILE] [-o FILE] [--repair] [--detect-only] [--explain]
         [--encoding utf8|latin1|cp1251|cp1252|auto] [--min-score N]
         [--file-encoding NAME] [--json] [--quiet]
         [--fail-on-change] [--require-change] [--version] [--help]
```

| Option | Meaning |
| --- | --- |
| `-i, --input FILE` | Read from FILE (default: stdin) |
| `-o, --output FILE` | Write the text to FILE (always UTF-8) |
| `--repair` | Actually repair. Detection is the default |
| `--detect-only` | Force detection, even if `--repair` was given |
| `--explain` | Print every candidate with its score and reasoning |
| `--encoding NAME` | Assume the misdecoding was NAME (`auto` = try all) |
| `--min-score N` | Confidence threshold, 0..1 (default `0.6`) |
| `--file-encoding NAME` | Decode the input file as NAME (default: sniff) |
| `--json` | Machine-readable report on stdout |
| `--quiet` | Suppress stdout; exit codes still apply |
| `--fail-on-change` | Exit 1 if the text was repaired |
| `--require-change` | Exit 3 if no repair was made |

**Exit codes:** `0` ok · `1` repaired and `--fail-on-change` · `2` usage or I/O
error · `3` nothing repaired and `--require-change`.

**Output routing:** `--json` always wins on stdout. Otherwise `-o` writes the
file and the report goes to stdout. Otherwise `--repair` into a pipe emits only
the text; `--repair` into a terminal shows the report. **Detection never emits
the text**, so a detection run can never clobber a pipeline by accident.

---

## Library

```js
const { repair, looksMojibake, detectFileEncoding } = require('mojibake-repair');

const result = repair("FranÃ§ais: cafÃ©");
result.value;      // "Français: café"
result.changed;    // true
result.encoding;   // "cp1252"
result.confident;  // true
result.original;   // always the exact input
result.reason;     // why
result.candidates; // every hypothesis, ranked, with scores
```

`repair()` returns `{ value, original, changed, confident, best, encoding,
detection, candidates, reason, options }`. **`original` is always the exact input
string**, so nothing is ever unrecoverable.

```js
looksMojibake("Größe, Straße, «Gruß» — Maß.").broken; // false
detectFileEncoding(buffer).encoding;                 // 'utf8' | 'utf16le' | ...
```

---

## How detection works

Four structural signals, each independently validated false-positive-free against
a corpus of correct text in French, Spanish, Portuguese, German, Turkish, Polish,
Czech, Romanian, Nordic, Russian, Ukrainian, Bulgarian, Macedonian, Serbian,
Japanese, Chinese, Arabic, Hebrew, Greek, maths and emoji.

| Signal | Weight | Fires when |
| --- | --- | --- |
| `utf8-pair` | 0.60 | ≥2 UTF-8 lead bytes adjacent to a continuation char, ratio ≥ 0.50 |
| `c1-control` | 0.50 | ≥1 raw C1 control char (U+0080–U+009F), ratio ≥ 0.02 |
| `replacement` | 0.50 | ≥1 U+FFFD already in the input |
| `cyrillic-extras` | 0.45 | ≥2 Cyrillic letters on cp1251's padding block, ratio ≥ 0.26 |

Scores saturate at 1; the suspect threshold is **0.4**, below the lowest signal
weight, because each signal is individually false-positive-free at its own
threshold.

### The thresholds are measured, not guessed

The separation each threshold sits in, taken from the calibration corpus:

| Signal | Correct text (max) | Broken text (min) | Threshold |
| --- | --- | --- | --- |
| `utf8-pair` ratio | 0.100 (German `Maß»`) | 0.947 | **0.50** |
| `utf8-pair` count | 1 | 20 | **2** |
| `c1-control` ratio | 0.000 | 0.063 | **0.02** |
| `cyrillic-extras` ratio | 0.206 (Serbian) | 0.333 | **0.26** |

`Maß»` is the case that matters: correct German really does contain a lead byte
next to a continuation character. It is not saved by a smarter definition — it is
saved by requiring **two** pairs and a **ratio**, where it scores 1 and 0.10
against thresholds of 2 and 0.50.

### Why bigrams, not characters

Artefacts are matched **structurally**, from a derived continuation set rather
than a hardcoded list of strings. A hardcoded list is wrong twice over: it misses
variants nobody enumerated, and every real artefact string in it gets
re-mojibaked by whoever pastes it through a terminal.

The continuation set is derived from the codec tables, because it is *not* the
Latin-1 range: windows-1252 maps `0x80–0x9F` to typographic punctuation (so
`â‚¬` and `â€™` appear), windows-1251 maps them to `ЁЂЃ`, and `U+0178` — from
`0xC3 0x9F` in `Größe` — lies outside `U+0080–U+00BF` entirely.

The lead range covers **2, 3 and 4-byte** UTF-8 sequences (`U+00C2–U+00F4`). A
2-byte-only range silently misses the euro sign (`0xE2`) and every emoji
(`0xF0`).

---

## How repair is ranked

Every hypothesis is generated, scored independently, and ranked. A candidate that
introduced a `U+FFFD` is **disqualified**, not merely penalised — bytes thrown
away can never come back.

| Weight | Component | Why |
| --- | --- | --- |
| −100 | replacement chars | Data loss. Disqualified, not scored |
| +30 | script consistency | Russian must not read as a Latin/Cyrillic mix. Hard to game by shortening |
| +25 | artefact density | Counts both byte pairs **and** cp1251 padding letters; a repair drives it to zero |
| +15 | printable ratio | Catches control characters and symbol soup |
| +12 | language hint | Small frequency bonus. Breaks ties; **never** carries a decision |

Counting cp1251 padding letters alongside byte pairs is essential: without them a
cp1251 repair scores *zero* progress, because the broken and repaired forms are
equally pair-free, and a perfect repair gets rejected for the wrong reason.

**Determinism:** the score is a pure function of `(candidate, original)`. Ties
break on the fixed strategy order, never on locale-sensitive comparison. The same
input always ranks the same way — asserted across repeated calls and across fresh
module instances.

---

## Known limitations

Both are deliberate refusals rather than silent corruption, and both are pinned
by tests.

**Mixed-encoding documents are refused.** A document whose lines broke
differently cannot be repaired by any single global encoding — French needs
cp1252 for byte `0x87`, Russian through latin1 contains `0x9F` which cp1252
remaps. Every hypothesis destroys at least one byte, so the tool returns the
original and says why, rather than silently corrupting one line.

**Residual `U+FFFD` may be retained.** When the input was already lossy and the
only recoverable hypothesis is lossy too, the repair goes ahead provided it does
not *increase* the replacement-character count. That rule is relative, so it is
never looser than "no `U+FFFD` may be introduced".

---

## Implementation notes

`Buffer` implements only utf8/latin1/ucs2, so mojibake repair needs its own
byte -> code point tables. `src/tables.js` vendors the two 256-entry tables
(encoding is required as well as decoding, which `Buffer` cannot do), and they
are generated from the **WHATWG Encoding Standard's own index files**, vendored
verbatim in [`spec/`](spec/):

```
node scripts/gen-tables.js && git diff --exit-code src/tables.js
```

CI runs that check on every Node version, so the tables cannot silently drift
from the standard.

The oracle is deliberately *not* `TextDecoder`. Node is an implementation of the
standard, not the standard, and Node 20 gets windows-1252 wrong: its ICU decodes
the C1 block as ISO-8859-1, so `0x80` becomes `U+0080` instead of `U+20AC`.
Generating tables from that runtime silently rewrites 32 correct bytes into a
latin1 identity map — a correct library turned wrong by a `node --version`
upgrade. `spec/index-windows-1251.txt` and `spec/index-windows-1252.txt` are
version-independent, and their upstream `Identifier:` headers are asserted by the
test suite so a hand-edited `spec/` cannot make the check pass.

`detect-file.js` works on the **Buffer**, never a decoded string — `toString('utf8')`
substitutes `U+FFFD`, so a "does this contain NUL?" test run after decoding gives
the wrong answer for a UTF-16 file. UTF-16 byte order is decided by scoring which
decoding produces plausible text, not by NUL parity alone, because ASCII in
UTF-16LE (`48 00 69 00`) has its NULs on the *odd* offsets and the naive rule
reads it as big-endian.

---

## Tests

```
npm test        # node --test
```

296 tests across 9 files, built on `node:test` and `node:assert` with no test
framework. Broken samples are **generated** by encoding correct text through the
wrong codec, so every true-positive test is self-proving: the expected value is
the original string, and a test can only pass if the tool reverses the same
transformation that broke the text.

Coverage includes the Russian and French true positives, a 31-sample
Western-European false-positive set, pure-ASCII passthrough, already-correct
Cyrillic, empty input, undecodable byte sequences handled without throwing,
deterministic ranking, the no-confident-repair path returning the original
byte-identical, and end-to-end CLI tests that spawn the real `bin/mojibake.js` and
assert real exit codes and real stdout.

CI runs on Node 20/22/24 across Linux, macOS and Windows.

---

## License

MIT © 2026 Xwalims
