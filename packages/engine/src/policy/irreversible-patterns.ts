// Irreversible patterns: words that mark an action as one that cannot be undone, such as deleting
// an account, paying, sending or revoking access. The engine ships a set per language and the
// trusted project adds its own per locale. A locale with neither has no set at all, and the
// policy gate denies every plan for it rather than guess.
import type { IrreversiblePatterns, Locale } from '@revisum/contracts';

// Keyed by language, so a target in fr-FR or fr-CA uses the French set.
export const BUILT_IN_IRREVERSIBLE_PATTERNS: Readonly<Record<string, readonly string[]>> = {
  en: ['delete', 'pay', 'send', 'revoke'],
  de: ['löschen', 'bezahlen', 'zahlen', 'senden', 'absenden', 'widerrufen'],
  fr: ['supprimer', 'payer', 'envoyer', 'révoquer'],
};

// The language part of a locale, such as "fr" for "fr-FR".
function languageOf(locale: string): string {
  try {
    return new Intl.Locale(locale).language;
  } catch {
    return locale;
  }
}

// Every pattern that applies under `locale`: the engine's set for its language and the project's
// sets for the locale and for its language. Null when none of them exists.
export function patternsForLocale(locale: Locale, projectPatterns: IrreversiblePatterns): readonly string[] | null {
  const keys = [...new Set<string>([locale, languageOf(locale)])];
  const project: Readonly<Record<string, readonly string[] | undefined>> = projectPatterns;
  const sets = keys.flatMap((key) => [BUILT_IN_IRREVERSIBLE_PATTERNS[key], project[key]]).filter((set) => set !== undefined);
  return sets.length === 0 ? null : [...new Set(sets.flat())];
}

// Every pattern any locale could use: the engine's sets for every language and every set the
// project declares. The static check uses it for a plan with no targets, so the engine's own
// patterns always apply, even when no target names a language.
export function everyIrreversiblePattern(projectPatterns: IrreversiblePatterns): readonly string[] {
  const project: Readonly<Record<string, readonly string[] | undefined>> = projectPatterns;
  const sets = [...Object.values(BUILT_IN_IRREVERSIBLE_PATTERNS), ...Object.values(project)].filter((set) => set !== undefined);
  return [...new Set(sets.flat())];
}

// Text compared the same however it was typed: composed Unicode, single spaces, trimmed.
const normalised = (text: string): string => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

// A lower-case letter followed by an upper-case one, and an upper-case run followed by a
// capitalised word, as in "deleteAccount" and "APIKeys": where camelCase joins two words.
const CAMEL_CASE_JOIN = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/gu;
// The same lower-to-upper join, and an upper-case run followed by a lower-case word, as in
// "DELETEaccount". It reads "APIKeys" wrongly, so it is a second reading, never the only one.
const CAPITALS_JOIN = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu}{2})(?=\p{Ll})/gu;

// Letters of other scripts that pass for a Latin letter, by that letter. Patterns are read through
// the same folding, so a pattern written in one of those scripts still matches its own words.
const LOOKALIKES_OF_LATIN: readonly (readonly [string, string])[] = [
  ['a', '\u0430\u0410\u03B1\u0391\u0251'], ['b', '\u0412\u0392'], ['c', '\u0441\u0421\u03F2\u03F9'], ['d', '\u0501'],
  ['e', '\u0435\u0415\u03B5\u0395'], ['g', '\u0261'], ['h', '\u04BB\u04BA\u041D\u0397'], ['i', '\u0456\u0406\u03B9\u0399\u0131\u04CF\u04C0'],
  ['j', '\u0458\u0408'], ['k', '\u043A\u041A\u03BA\u039A'], ['m', '\u041C\u039C'], ['n', '\u039D'], ['o', '\u043E\u041E\u03BF\u039F\u0585'],
  ['p', '\u0440\u0420\u03C1\u03A1'], ['q', '\u051B'], ['r', '\u0433'], ['s', '\u0455\u0405'], ['t', '\u0422\u03C4\u03A4'], ['u', '\u03C5\u057D'],
  ['v', '\u03BD\u0475'], ['w', '\u051D\u051C'], ['x', '\u0445\u0425\u03C7\u03A7'], ['y', '\u0443\u0423\u03A5'], ['z', '\u0396'],
];
const LATIN_FOR_LOOKALIKE: ReadonlyMap<string, string> = new Map(
  LOOKALIKES_OF_LATIN.flatMap(([latin, lookalikes]) => [...lookalikes].map((lookalike): [string, string] => [lookalike, latin])),
);
const LOOKALIKE = new RegExp(`[${[...LATIN_FOR_LOOKALIKE.keys()].join('')}]`, 'gu');

const withoutInvisibleForms = (text: string): string => text.normalize('NFKC').replace(/\p{Cf}/gu, '');

// Lookalikes are folded after the words are split: folding gives lower-case letters, which would
// hide a capital's join.
const readingWithJoin = (text: string, join: RegExp): string =>
  normalised(withoutInvisibleForms(text).replace(join, ' ').replace(LOOKALIKE, (lookalike) => LATIN_FOR_LOOKALIKE.get(lookalike) ?? lookalike));

// Text as the patterns read it, so a name cannot slip past them by how it is written:
// compatibility forms folded (NFKC turns full-width letters into ordinary ones), invisible format
// characters such as a soft hyphen or a zero-width joiner removed, lookalike letters folded and
// camelCase words split. Folding may make an unrelated name match ("PayPal" reads "Pay Pal"); that
// errs on the safe side.
const comparable = (text: string): string => readingWithJoin(text, CAMEL_CASE_JOIN);

// True when nothing a person could read is left once the name is read as the patterns read it.
export const isBlankName = (text: string): boolean => comparable(text) === '';

const REGULAR_EXPRESSION_SYNTAX = /[\\^$.*+?()[\]{}|/]/gu;

// A pattern as a whole-word, case-insensitive expression: no letter, digit or combining mark may
// touch it on either side, so "delete" matches "Delete account" but not "Deleted items".
function wholeWord(pattern: string): RegExp {
  const escaped = comparable(pattern).replace(REGULAR_EXPRESSION_SYNTAX, '\\$&').replace(/ /gu, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escaped}(?![\\p{L}\\p{N}\\p{M}])`, 'iu');
}

// True when any pattern appears in `text` as a whole word.
export function matchesIrreversiblePattern(text: string, patterns: readonly string[]): boolean {
  const readings = [comparable(text), readingWithJoin(text, CAPITALS_JOIN)];
  return patterns.some((pattern) => {
    const word = wholeWord(pattern);
    return readings.some((reading) => word.test(reading));
  });
}

// True when `name` is exactly one of the names the project allows, ignoring case and spacing.
export function isAllowedName(name: string, allowedNames: readonly string[]): boolean {
  const wanted = normalised(name).toLowerCase();
  return allowedNames.some((allowed) => normalised(allowed).toLowerCase() === wanted);
}
