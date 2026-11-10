// Privacy by default: elements matching personal-data selectors are masked in screenshots, and
// personal-data patterns are replaced in any text the engine keeps.
import type { Redactor } from "@revisum/contracts";

export const DEFAULT_PII_SELECTORS: readonly string[] = [
    'input[type="email"]',
    'input[type="password"]',
    'input[type="tel"]',
    'input[autocomplete~="email"]',
    'input[autocomplete~="tel"]',
    'input[autocomplete^="cc-"]',
    "[data-pii]",
    "[data-private]",
];

type PiiRule = {
    readonly label: string;
    readonly pattern: RegExp;
    // Left out when everything the pattern matches is personal data.
    readonly isPersonalData?: (match: string) => boolean;
};

export const DEFAULT_PII_PATTERNS: readonly PiiRule[] = [
    {
        label: "email",
        // Takes each run of name characters whole, with its domain if one follows, so a page's long run
        // with no "@" is read once rather than once from every character. Starting only where a run
        // starts would not do: a search resumes inside a run after an address that ends there, and
        // "a@b.co1x@c.org" holds two.
        pattern: /[A-Za-z0-9._%+-]+(?:@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?/g,
        isPersonalData: (match) => match.includes("@"),
    },
    { label: "card", pattern: /\b(?:\d[ -]?){13,19}\b/g },
    { label: "phone", pattern: /\+?\d[\d ()-]{7,}\d/g },
];

export function defaultRedactor(extraSelectors: readonly string[] = []): Redactor {
    return {
        selectors: [...DEFAULT_PII_SELECTORS, ...extraSelectors],
        text: (value) =>
            DEFAULT_PII_PATTERNS.reduce(
                (redacted, rule) =>
                    redacted.replace(rule.pattern, (match) =>
                        (rule.isPersonalData?.(match) ?? true) ? `[redacted:${rule.label}]` : match,
                    ),
                value,
            ),
    };
}

// Shown instead of any text read from an element that matches a sensitive selector.
export const SENSITIVE_PLACEHOLDER = "[redacted:sensitive-element]";
