// Irreversible patterns: words that mark an action as one that cannot be undone, such as deleting
// an account, paying, sending or revoking access. The engine ships a set per language and the
// trusted project adds its own per locale. A locale with neither has no set at all, and the
// policy gate denies every plan for it rather than guess.
// See docs/specs/SPEC-03-policy-gate.md.
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

// Text as the patterns read it, so a name cannot slip past them by how it is written:
// compatibility forms folded (NFKC turns full-width letters into ordinary ones), invisible format
// characters such as a soft hyphen or a zero-width joiner removed, and camelCase words split.
// Folding may make an unrelated name match ("PayPal" reads "Pay Pal"); that errs on the safe side.
const comparable = (text: string): string =>
  normalised(text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(CAMEL_CASE_JOIN, ' '));

const REGULAR_EXPRESSION_SYNTAX = /[\\^$.*+?()[\]{}|/]/gu;

// A pattern as a whole-word, case-insensitive expression: no letter, digit or combining mark may
// touch it on either side, so "delete" matches "Delete account" but not "Deleted items".
function wholeWord(pattern: string): RegExp {
  const escaped = comparable(pattern).replace(REGULAR_EXPRESSION_SYNTAX, '\\$&').replace(/ /gu, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escaped}(?![\\p{L}\\p{N}\\p{M}])`, 'iu');
}

// True when any pattern appears in `text` as a whole word.
export const matchesIrreversiblePattern = (text: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => wholeWord(pattern).test(comparable(text)));

// True when `name` is exactly one of the names the project allows, ignoring case and spacing.
export function isAllowedName(name: string, allowedNames: readonly string[]): boolean {
  const wanted = normalised(name).toLowerCase();
  return allowedNames.some((allowed) => normalised(allowed).toLowerCase() === wanted);
}
