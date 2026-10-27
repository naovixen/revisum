// Privacy by default: elements matching personal-data selectors are masked in screenshots, and
// personal-data patterns are replaced in any text the engine keeps.
// See docs/specs/SPEC-09-privacy-masking.md.
import type { Redactor } from '@revisum/contracts';

export const DEFAULT_PII_SELECTORS: readonly string[] = [
  'input[type="email"]',
  'input[type="password"]',
  'input[type="tel"]',
  'input[autocomplete~="email"]',
  'input[autocomplete~="tel"]',
  'input[autocomplete^="cc-"]',
  '[data-pii]',
  '[data-private]',
];

export const DEFAULT_PII_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { label: 'card', pattern: /\b(?:\d[ -]?){13,19}\b/g },
  { label: 'phone', pattern: /\+?\d[\d ()-]{7,}\d/g },
];

export function defaultRedactor(extraSelectors: readonly string[] = []): Redactor {
  return {
    selectors: [...DEFAULT_PII_SELECTORS, ...extraSelectors],
    text: (value) => DEFAULT_PII_PATTERNS.reduce((redacted, rule) => redacted.replace(rule.pattern, `[redacted:${rule.label}]`), value),
  };
}

// Shown instead of any text read from an element that matches a sensitive selector.
export const SENSITIVE_PLACEHOLDER = '[redacted:sensitive-element]';
