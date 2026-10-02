'use strict';

// Shared fixtures.
//
// Broken samples are GENERATED here by encoding correct text through the wrong
// codec, never pasted as literal mojibake. That makes every true-positive test
// self-proving: the expected value is the original string, so a test can only
// pass if the tool genuinely reverses the same transformation that broke the
// text. A pasted literal would instead assert against a string that is easy to
// get subtly wrong, and impossible to keep in sync with the implementation.
//
// It also means the false-positive set and the true-positive set are generated
// from the same source of truth, so "this text is repaired" and "this text is not"
// are claims about the same corpus rather than about two hand-written lists.

const { mojibake } = require('../src/codecs.js');

/** Correct text in each language, used as the source for broken samples. */
const CORRECT = Object.freeze({
  ru: 'Привет, мир! Как дела? Сегодня хорошая погода.',
  ru2: 'Съешь же ещё этих мягких французских булок, да выпей чаю.',
  fr: "Français: café, naïf, à côté de l'été. Ça va très bien, garçon précis.",
  es: 'El español: ¿dónde está el corazón? Mañana será. ¡Sí! Añadir, útil.',
  pt: 'Português: coração, ação, não, informação. É ótimo, três,ões, você.',
  tr: "Türkçe: İstanbul'da güzel, şey, çiçek. Öğrenmek, Çanakkale, ğüşümüš.",
  de: 'Größe, Straße, Müller, Ärzte, Öl, Übung, fünfte Fuß. ÄÖÜ äöü «Gruß» — Maß.',
  pl: 'Zażółć gęślą jaźń. ĄĆĘŁŃÓŚŹŻ, Kraków, Łódź.',
  cs: 'Příliš žluťoučký kůň úpěl ďábelské ódy.',
  ro: 'Țara noastră e frumoasă, ținutul, sărutări.',
  uk: 'Привіт, світе! Сьогодні гарна погода. Україна, їжак, єдність.',
  bg: 'Здравей, свят! Как си оваташ? България е голяма, хубаво.',
  mk: 'Здраво, свет! Како си денес? Македонија, ѕ, ј, ќ, џ, љ, њ.',
  sr: 'Здраво, свете! Како си данас? Србија, ђ, ј, љ, њ, ћ, џ.',
  ja: 'こんにちは世界！元気ですか。ありがとう。',
  zh: '你好世界！今天天气很好。',
  ar: 'مرحبا بالعالم! كيف حالك اليوم؟',
  he: 'שלום עולם! מה קורה? תודה רבה.',
  el: 'Γειά σου Κόσμε! Τι κάνεις; Καλημέρα, όλα καλά.',
  en: 'Hello world. The quick brown fox jumps over the lazy dog.',
  ascii: 'Hello world, plain ASCII only. 12345.',
  math: '∑∫≈≤≥≠±×÷∈∉⊂⊃∪∩ ∀∃¬∧∨ ⇒ ⇔ ∞ αβγδ πθλμ',
  emoji: 'Hello 👋 world — em dash, ünïcödé, math ∑, arrows →',
  currency: '€10 £20 ¥30 ¢5 — prices: 10€',
  quotes: 'Он сказал: «Привет, мир!» — сказал он.',
  empty: '',
});

/**
 * Text that must never be modified. Every entry is correct text in a language
 * with a rich Latin-1 or Latin-Extended-A repertoire, i.e. exactly the input a
 * naive "does it contain accented characters" detector would corrupt.
 */
const MUST_NOT_CHANGE = Object.freeze([
  CORRECT.fr,
  CORRECT.es,
  CORRECT.pt,
  CORRECT.tr,
  CORRECT.de,
  CORRECT.pl,
  CORRECT.cs,
  CORRECT.ro,
  CORRECT.ru,
  CORRECT.ru2,
  CORRECT.uk,
  CORRECT.bg,
  CORRECT.mk,
  CORRECT.sr,
  CORRECT.ja,
  CORRECT.zh,
  CORRECT.ar,
  CORRECT.he,
  CORRECT.el,
  CORRECT.en,
  CORRECT.ascii,
  CORRECT.math,
  CORRECT.emoji,
  CORRECT.currency,
  CORRECT.quotes,
  CORRECT.empty,
  // German with the ß» adjacency: the case that broke the first draft of the
  // byte-pair detector. It is a false positive for any presence-based rule.
  'Maß»',
  'Große Straße, schöne Häuser, grüne Bäume, weiße Mauer, «Gruß»',
  // Nordic: Æ Ø Å are lead bytes under some definitions.
  'Æblegrød, Ørsted, Åsa, æon, smørrebrød, blåbær, färg, för, där, något.',
  // French with guillemets and a cedilla after an accented vowel.
  '«Français», ça va, garçon, à l’heure, où est-il, naïvement, l’été.',
  // Spanish opening punctuation next to an accent.
  '¿Dónde está el corazón? ¡Sí! Añadir útil ñandú pingüino Schrödinger.',
]);

/**
 * Generate a broken sample by encoding correct text through the wrong codec.
 * @param {string} correct
 * @param {string} codec
 * @returns {string}
 */
function breakText(correct, codec) {
  return mojibake(correct, codec);
}

/**
 * True-positive matrix: [name, correct text, codec that broke it].
 * @returns {ReadonlyArray<readonly [string, string, string]>}
 */
function brokenCases() {
  return [
    ['ru via latin1', CORRECT.ru, 'latin1'],
    ['ru via cp1251', CORRECT.ru, 'cp1251'],
    ['ru2 via latin1', CORRECT.ru2, 'latin1'],
    ['ru2 via cp1251', CORRECT.ru2, 'cp1251'],
    ['uk via cp1251', CORRECT.uk, 'cp1251'],
    ['bg via cp1251', CORRECT.bg, 'cp1251'],
    ['mk via cp1251', CORRECT.mk, 'cp1251'],
    ['fr via latin1', CORRECT.fr, 'latin1'],
    ['fr via cp1252', CORRECT.fr, 'cp1252'],
    ['es via latin1', CORRECT.es, 'latin1'],
    ['es via cp1252', CORRECT.es, 'cp1252'],
    ['pt via cp1252', CORRECT.pt, 'cp1252'],
    ['tr via latin1', CORRECT.tr, 'latin1'],
    ['de via latin1', CORRECT.de, 'latin1'],
    ['de via cp1252', CORRECT.de, 'cp1252'],
    ['pl via cp1252', CORRECT.pl, 'cp1252'],
    ['cs via cp1252', CORRECT.cs, 'cp1252'],
    ['ro via cp1252', CORRECT.ro, 'cp1252'],
    ['quotes via cp1252', CORRECT.quotes, 'cp1252'],
    ['quotes via latin1', CORRECT.quotes, 'latin1'],
    ['currency via cp1252', CORRECT.currency, 'cp1252'],
  ];
}

module.exports = Object.freeze({
  CORRECT,
  MUST_NOT_CHANGE,
  breakText,
  brokenCases,
});