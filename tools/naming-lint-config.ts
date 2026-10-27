// What the naming lint bans and allows. This file is excluded from the lint because it has to
// spell out the very words it bans. See docs/specs/SPEC-00-repo-seed-and-gates.md for the rules.

export type NamingRule = { readonly pattern: RegExp; readonly why: string };

export type NamingLintConfig = {
  // Repository-relative globs. "**" matches any number of folders, "*" matches within one name.
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  // Matched against each word of a name, whole word, case-insensitive.
  readonly bannedWords: readonly NamingRule[];
  // Matched against the whole name or text.
  readonly bannedText: readonly NamingRule[];
  readonly bannedInComments: readonly NamingRule[];
  // Exact, case-sensitive exceptions to bannedWords.
  readonly allowedWords: readonly string[];
  // Abbreviation, then the word to write instead. Any name using the abbreviation fails.
  readonly spellOut: Readonly<Record<string, string>>;
  // Informational: abbreviations a reviewer accepts without a glossary entry.
  readonly allowedAbbreviations: readonly string[];
  // Acronym, then its full name. Each must also appear in docs/glossary.md.
  readonly standardNames: Readonly<Record<string, string>>;
  // The only single-letter names allowed, and never as exports.
  readonly singleLetterNames: readonly string[];
  // Criterion ids may appear only as the value of a test's `criterion` option.
  readonly criterionIdPattern: RegExp;
};

export const NAMING_LINT: NamingLintConfig = {
  include: ['packages/**', 'tools/**', 'test/**', 'proofs/**', 'fixtures/**', 'golden/**', 'scripts/**', '.github/**', '*.json'],
  exclude: [
    'docs/**',
    'seed-provenance.json',
    'seed/provenance.json',
    'package-lock.json',
    'tools/naming-lint-config.ts',
    'fixtures/naming-lint/**',
    '**/node_modules/**',
    '**/dist/**',
    '**/*.tsbuildinfo',
  ],
  bannedWords: [
    { pattern: /^r(1[0-3]|[1-9])$/i, why: 'research requirement id' },
    { pattern: /^(rc|fr|nfr|up)\d{2}$/i, why: 'role criterion, requirement or user-problem id' },
    { pattern: /^(sc|fd)\d$/i, why: 'success criterion or founder decision id' },
    { pattern: /^h(1[0-8]|[7-9])$/i, why: 'hypothesis id (H1-H6 are left to review: they clash with HTML headings)' },
    { pattern: /^p[1-7]$/i, why: 'spike name' },
    { pattern: /^(d|f|rt|r)\d{1,2}$/i, why: 'research job id' },
    { pattern: /^(doc|finding)\d+$/i, why: 'research doc or finding number' },
    { pattern: /^ac$/i, why: 'acceptance criterion: write "criterion"' },
    { pattern: /^spec\d{2}$/i, why: 'spec number: name the domain concept' },
  ],
  bannedText: [{ pattern: /C-R[0-9A-Z]{2,3}-\d{3}/i, why: 'claim id' }],
  bannedInComments: [
    { pattern: /\b(RC|FR|NFR|UP)-\d{2}\b|\b(SC|FD)-\d\b|\bH(1[0-8]|[1-9])\b|\bR(1[0-3]|[1-9])\b/, why: 'research id' },
    { pattern: /\bC-R[0-9A-Z]{2,3}-\d{3}\b/, why: 'claim id' },
    { pattern: /\bspikes?\b|\bp[1-7]\b|\bP[5-7]\b/, why: 'spike name' },
    { pattern: /\bFinding \d+\b|`(0\d|1[0-3])`|docs\/research\//, why: 'research doc citation' },
    { pattern: /^\s*\(?\s*(see\s+)?(docs\/specs\/)?SPEC-\d{2}[\w.-]*\s*\)?\s*\.?\s*$/i, why: 'a spec reference cannot be the whole comment' },
  ],
  allowedWords: ['P1', 'P2', 'P3', 'P4'],
  spellOut: {
    ac: 'criterion', cfg: 'config', ctx: 'context', env: 'environment', err: 'error', max: 'maximum',
    mb: 'megabytes', md: 'markdown', min: 'minimum', ms: 'milliseconds', msg: 'message', opts: 'options',
    pct: 'percent', perf: 'performance', prev: 'previous', ref: 'reference', repo: 'repository', seq: 'sequence',
    vcs: 'version control',
  },
  allowedAbbreviations: ['id', 'url', 'uri', 'html', 'css', 'json', 'http', 'api', 'cli', 'ci', 'pr', 'cdp', 'bidi',
    'wcag', 'act', 'a11y', 'pii', 'sha256', 'svg', 'png', 'dom', 'os'],
  standardNames: {
    ai: 'artificial intelligence', mcp: 'Model Context Protocol', sarif: 'Static Analysis Results Interchange Format',
    junit: 'JUnit XML test-report format', oidc: 'OpenID Connect', jwt: 'JSON Web Token', lti: 'Learning Tools Interoperability',
  },
  singleLetterNames: ['i', 'j', 'k', 'x', 'y'],
  criterionIdPattern: /\bAC-SPEC-\d{2}-\d{2}\b/,
};
