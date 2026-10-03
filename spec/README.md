# Vendored WHATWG index files

`index-windows-1251.txt` and `index-windows-1252.txt` are copied verbatim from
the WHATWG Encoding Standard:

    https://github.com/whatwg/encoding/blob/main/index-windows-1251.txt
    https://github.com/whatwg/encoding/blob/main/index-windows-1252.txt

Each file carries an upstream `Identifier:` line and a `Date:` in its header.
Nothing here was edited — the header comments, the row format and the trailing
newline are upstream's. `scripts/gen-tables.js` turns these into the 256-entry
tables in `src/tables.js`, and `test/tables.test.js` asserts the two agree for
every byte.

## Why these files and not `TextDecoder`

The tables used to be generated from Node's own `TextDecoder`, described in the
README as "the WHATWG reference implementation". Node is an implementation *of*
the standard, not the standard, and at least one supported version gets
windows-1252 wrong: Node 20's ICU decodes it as ISO-8859-1, so

    new TextDecoder('windows-1252').decode(Uint8Array.of(0x80))  // Node 20 -> U+0080
    new TextDecoder('windows-1252').decode(Uint8Array.of(0x80))  // correct -> U+20AC

Regenerating from that runtime rewrites all 32 C1 bytes into an identity table
and turns a correct library into a wrong one. The standard's own index files are
version-independent, so the oracle cannot drift with the runner image.

Copyright © WHATWG (Apple, Google, Mozilla, Microsoft), licensed under
Creative Commons Attribution 4.0 International; portions incorporated into
source code are BSD 3-Clause. See
https://github.com/whatwg/encoding/blob/main/LICENSE