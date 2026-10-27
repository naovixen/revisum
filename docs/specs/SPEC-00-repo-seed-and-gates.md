# SPEC-00: Repo seed, licences and build gates

## Purpose

Create core's product repository, separate from the research repository, seeded from the committed spikes, so that every later spec is built inside the rules core sells: tests owned apart from code, and deterministic gates. Core itself is built spec-first (FD-5), and the repo answers "the agent says its tests pass, but it wrote the tests" (UP-04) for core's own build. Outcome: one standalone repo, green on a pinned Linux image, readable without the research, with the MVP plan's Definition of Done (research `09`) enforced from week 0.

## Scope and non-goals

- **In:**
  - **A new, separate product repo.** The founder commits `docs/research/spikes/` in the research repo first. The product repo is seeded from that commit: the core skeleton (spike P3), the own CDP driver (P4), the own accessibility engine (P5), the report renderer (P6) and the API-step core types (P7), all behind the core skeleton's ports.
  - **Docs that move with it.** `docs/specs/` (SPEC-00 to SPEC-29), `docs/system-design.md` and `docs/glossary.md`. The research stays in the research repo as history. Nothing in the product repo depends on a file that exists only in the research repo, except the seed provenance record. Research background cited under a spec's Dependencies (doc numbers, claim ids) is history, not a build input.
  - Separate TypeScript projects for core, adapters, packs and renderers.
  - **Licences.** The engine is FSL-1.1-ALv2 (Functional Source License 1.1, converting to Apache-2.0). Schemas, SDKs, drivers and adapters are Apache-2.0.
  - `CONTRIBUTING.md` with the spec template, the Definition of Done and the naming rule.
  - **Tests apart from code.** CODEOWNERS on `test/` and a required `tests-apart` status check.
  - **Human approval for core's own build (solo, no hardware key).**
    - The coding agent is locked out of commit, push, merge and pull-request approval: deny rules in its settings, and no GitHub credentials in its environment.
    - The founder commits, pushes and merges personally. Only the protected default branch is trusted.
    - Core records these approvals as `declared`, not `verified`, and says so (the agent lock-down route in SPEC-02).
    - Nothing is gated behind a second person (founder, 2026-10-27). If a second maintainer joins, code-owner review by their account becomes an optional verified route, never a required one.
  - CI with `tsc`, lints (including the naming lint), contract suites, proofs, replay and ACT re-score.
  - **A dependency review (the R11 keep/drop test)** per third-party component on the trust path.
  - **Core's own metrics.** `agentAuthoredShare` and `specLinkedShare` from commit trailers; `tracedCriteriaShare` and `flakyRunRate` from CI.
  - **A guarantee map.** Each phase-1 row of the published guarantee table (research `04` Finding 1; success criterion SC-2) is tied to a CI test.
  - **Naming rule.** It applies to every code identifier: types, functions, variables, constants, files, folders, packages, JSON keys, error codes, CLI flags and event names.
    1. **No research or process ids.** That bans:
       - research requirements R1–R13;
       - RC-nn, FR-nn, NFR-nn, UP-nn, SC-n, FD-n and H1–H18;
       - spike names P1–P7 and p3–p7;
       - job ids (D14, F2, RT2…);
       - claim ids `C-…`;
       - doc numbers such as `04` and "Finding 3".
    2. **Domain words a new developer understands.**
       - No single-letter names except loop indices and x/y coordinates.
       - No unexplained abbreviations. Allowed: id, url, uri, html, css, json, http, api, cli, ci, pr, cdp, bidi, wcag, act, a11y, pii, sha256, svg, png, dom, os.
       - Standard names that are always written as acronyms (ai, mcp, sarif, junit, oidc, jwt, lti) are allowed only with their expansion in the glossary.
    3. **Comments say what and why in plain English and stand alone.** A comment may add "see `docs/specs/SPEC-nn-<name>.md`", but never as its only content. It never cites research docs, claim ids or spike names.
    4. **Traceability lives in data, not names.** `AC-SPEC-nn-mm` ids appear only:
       - as string values in test metadata (`criterion: 'AC-SPEC-01-03'`);
       - in commit trailers and the trace index.
    5. **A CI naming lint enforces rules 1–4** (`NamingLintConfig`). `docs/glossary.md` maps each domain term to its code name.
- **Non-goals:** new features; Playwright on the default path; hosting; publishing to npm (SPEC-16); a hardware or signed key for core's own approvals.

## Interfaces and types

```ts
// One constant carries the placeholder name; nothing else hard-codes it.
export const PRODUCT = { name: 'core', schemaNamespace: 'core' } as const;

// The checks every third-party component on the trust path must pass to stay on the default path.
export type DependencyCheck =
  | 'licenceAllowsUse'     // licence permits commercial use and distribution
  | 'reachesAllTargets'    // can drive every target core must support
  | 'versionPinned'        // an exact version can be pinned and run hermetically
  | 'stockBrowsersOnly'    // needs no patched or vendor-only browser build
  | 'gapsClosable'         // any accessibility coverage gap can be closed around it
  | 'roadmapFits';         // its roadmap can't break core's guarantees
// One dependency review per third-party component on the trust path.
export type DependencyReview = {
  readonly component: string;            // e.g. "axe-core"
  readonly version: string;              // exact, pinned
  readonly results: Readonly<Record<DependencyCheck, 'pass' | 'fail' | 'partial'>>;
  readonly decision: 'default' | 'optional-adapter' | 'dropped';
  readonly evidence: readonly string[];  // CI test ids, licence files or vendor documents behind each result
};

// Test set for the tests-apart check; everything else is code under test.
export const TEST_SET = ['test/**', 'proofs/**', 'fixtures/**', 'golden/**'] as const;

// Commit trailers (git interpret-trailers format), read for core's own metrics:
//   Agent: <tool>/<version>          present when an agent authored the commit (declared); feeds agentAuthoredShare
//   Spec: SPEC-nn                    one per spec the commit implements; feeds specLinkedShare
//   Criteria: AC-SPEC-nn-mm[, AC-SPEC-nn-mm]

// Where each seeded file came from. The only file in the product repo that points at the research repo.
export type SeedProvenance = {
  readonly researchRepoCommit: string;
  readonly files: readonly { readonly from: string; readonly to: string; readonly sourceSha256: string }[];
  // Spike acceptance criteria reused by this repo's criteria, kept as values so no name carries them.
  readonly reusedCriteria: readonly { readonly spikeCriterion: string; readonly specCriteria: readonly string[] }[];
};

// Each phase-1 guarantee core publishes (structural, type-level or runtime), mapped to the CI test that proves it.
export type GuaranteeRow =
  | 'ai-output-only-as-plan' | 'known-actions-only' | 'lifecycle-no-skip' | 'declared-log-fields' | 'targets-not-substituted'
  | 'browser-egress-allow-list' | 'secrets-absent' | 'pii-masked-in-pixels' | 'no-pii-in-reports' | 'same-inputs-same-result'
  | 'adapters-substitutable' | 'report-runs-no-content' | 'actions-tamper-evident' | 'spec-to-commit-trace' | 'person-approval';
// Disclosed, not tested in phase 1: plan semantically right, AI judgements right (statistical); prompt injection
// prevented (not achievable); HTTP and identity allow-list, retries and tokens (phase 2 protocol packs).
export type GuaranteeMap = Readonly<Record<GuaranteeRow, { testId: string }>>;

// Naming lint, run in CI. Identifiers are split into words at case changes and at _ - . / ;
// a digit-only word is also tried joined to the word before it, so "step-12" and "Step12" both give "step12".
export type NamingLintConfig = {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly bannedWords: readonly { readonly pattern: RegExp; readonly why: string }[];     // whole word, case-insensitive
  readonly bannedText: readonly { readonly pattern: RegExp; readonly why: string }[];      // matched on the whole identifier
  readonly bannedInComments: readonly { readonly pattern: RegExp; readonly why: string }[];
  readonly allowedWords: readonly string[];                 // exact, case-sensitive exceptions to bannedWords
  readonly spellOut: Readonly<Record<string, string>>;      // abbreviation -> word to write instead; a match fails
  readonly allowedAbbreviations: readonly string[];         // any other abbreviation fails code review
  readonly standardNames: Readonly<Record<string, string>>; // acronym -> full name; each also in docs/glossary.md
  readonly singleLetterNames: readonly string[];            // loop indices and coordinates; never exported
  readonly criterionIdPattern: RegExp;                      // only in test-metadata strings, trailers and the trace index
};
export const NAMING_LINT: NamingLintConfig = {
  include: ['packages/**', 'test/**', 'proofs/**', 'fixtures/**', 'golden/**', 'scripts/**', '.github/**', '*.json'],
  exclude: ['docs/**', 'seed/provenance.json', 'fixtures/naming-lint/**', '**/node_modules/**'], // the lint's own failing fixtures
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
  allowedWords: ['P1', 'P2', 'P3', 'P4'],                   // severity labels, an industry convention
  spellOut: { ac: 'criterion', cfg: 'config', ctx: 'context', env: 'environment', err: 'error', max: 'maximum',
    mb: 'megabytes', md: 'markdown', min: 'minimum', ms: 'milliseconds', msg: 'message', opts: 'options',
    pct: 'percent', perf: 'performance', prev: 'previous', ref: 'reference', repo: 'repository', seq: 'sequence',
    vcs: 'version control' },
  allowedAbbreviations: ['id', 'url', 'uri', 'html', 'css', 'json', 'http', 'api', 'cli', 'ci', 'pr', 'cdp', 'bidi',
    'wcag', 'act', 'a11y', 'pii', 'sha256', 'svg', 'png', 'dom', 'os'],
  standardNames: { ai: 'artificial intelligence', mcp: 'Model Context Protocol', sarif: 'Static Analysis Results Interchange Format',
    junit: 'JUnit XML test-report format', oidc: 'OpenID Connect', jwt: 'JSON Web Token', lti: 'Learning Tools Interoperability' },
  singleLetterNames: ['i', 'j', 'k', 'x', 'y'],
  criterionIdPattern: /\bAC-SPEC-\d{2}-\d{2}\b/,
};

// Dependency direction, enforced by TypeScript project references:
// core <- adapters, packs, renderers, cli   (core imports none of them)
```

## Acceptance criteria

- AC-SPEC-00-01: When CI runs on the pinned Linux image, core shall pass, unchanged: the core skeleton's 32 contract tests and 22 proofs (spike P3); the CDP driver's contract suite (P4); the accessibility engine's ACT re-score (P5); and the report renderer's golden report (P6) (oracle: regression; reuses AC-p4-01, AC-p4-02, AC-p5-11, AC-p6-20).
- AC-SPEC-00-02: When any file in the core project imports an adapter, pack, renderer or third-party package, the build shall fail (oracle: specified; generalises AC-p4-07 and AC-p5-01).
- AC-SPEC-00-03: When the core package manifest is read, its runtime `dependencies` shall be empty (oracle: specified).
- AC-SPEC-00-04: When a third-party component on the trust path has no `DependencyReview`, or has a failing check with decision `default`, CI shall fail (oracle: specified).
- AC-SPEC-00-05: When a pull request changes any file in `TEST_SET` and any file outside it, the required `tests-apart` check shall fail, and branch protection shall block the merge because the check is required (oracle: specified).
- AC-SPEC-00-06: When the source is searched, the product name shall appear only in the `PRODUCT` constant (oracle: specified).
- AC-SPEC-00-07: When CI finishes on the default branch, it shall record:
  - core's own `tracedCriteriaShare` and `flakyRunRate` for the run;
  - `agentAuthoredShare` from `Agent:` trailers;
  - `specLinkedShare` from `Spec:` and `Criteria:` trailers.

  A commit with a malformed trailer shall fail the check (oracle: specified).
- AC-SPEC-00-08: When the licence check runs (oracle: specified):
  - schemas, SDKs, drivers and adapters shall carry Apache-2.0;
  - the engine shall carry FSL-1.1-ALv2 (Functional Source License 1.1, converting to Apache-2.0);
  - axe-core's MPL-2.0 files shall be byte-identical to the pinned release.
- AC-SPEC-00-09: When the monthly cost report runs at zero customers, hosted spend shall be at most USD 5 (oracle: specified; the research cost model, `06`, estimates about USD 1).
- AC-SPEC-00-10: When CI runs, every `GuaranteeRow` shall map to a test id that exists and passes. A row with no test, or a failing one, shall fail CI, and the published table shall show the row's weaker class (oracle: specified).
- AC-SPEC-00-11: When the repo is seeded, every spike file a spec names shall be copied, with the research-repo commit and its source hash recorded in `SeedProvenance`. Seeding shall fail if that commit does not contain the file (oracle: specified).
- AC-SPEC-00-12: When the naming lint runs over a fixture with one identifier per banned pattern, each shall fail with its `why`, and the same names spelt as domain words shall pass (oracle: specified). The fixture includes `R11Test`, `acId`, `p3Core`, `checkD14`, a JSON key `RC-04`, an error code `h12-failed` and a claim id.
- AC-SPEC-00-13: When an exported name is a single letter, or a non-exported single-letter name (including a generic type parameter) is outside `singleLetterNames`, the lint shall fail. Loop indices `i`, `j`, `k` and coordinates `x`, `y` shall pass (oracle: specified).
- AC-SPEC-00-14: When a comment cites a research doc, a claim id, a spike name or a research id, or consists only of a spec reference, the lint shall fail. A plain explanation followed by "see `docs/specs/SPEC-09-privacy-masking.md`" shall pass (oracle: specified).
- AC-SPEC-00-15: When an id matching `criterionIdPattern` appears anywhere other than a test-metadata string value, a commit trailer or the trace index, the lint shall fail. Every test's `criterion` value shall name a criterion that exists in `docs/specs/` (oracle: specified).
- AC-SPEC-00-16: When CI runs, `docs/glossary.md` shall map each domain term to its code name (oracle: specified):
  - every code name it lists shall resolve to an exported declaration;
  - every exported type of the core package's public API shall appear in it;
  - every `standardNames` entry shall appear with its full name.
- AC-SPEC-00-17: When CI searches the product repo, no code, test, script, config or CI file shall read, import or link a file that exists only in the research repo, and `SeedProvenance` shall be the only file naming the research-repo commit (oracle: specified).
- AC-SPEC-00-18: When the repo is seeded (oracle: specified):
  - `docs/specs/` shall hold SPEC-00 to SPEC-29 with every AC id unchanged, beside `docs/system-design.md` and `docs/glossary.md`;
  - every seeded spike file shall pass the naming lint;
  - spike criterion ids shall survive only in `SeedProvenance.reusedCriteria`.
- AC-SPEC-00-19: When CI runs on core's own protected default branch (oracle: specified):
  - it shall check that the agent's deny-rules file there denies commit, push, merge and pull-request approval;
  - core's own approvals and the metrics resting on them shall be recorded and shown as `declared`, not `verified`.
- AC-SPEC-00-20: When CI reads the branch protection and rulesets of core's own default branch, none shall require an approving review from another account, and a merge by the founder under the agent lock-down shall satisfy every required gate (oracle: specified; founder decision 2026-10-27, "don't gate anything behind a second person").

## Dependencies

- Spikes `docs/research/spikes/p3` to `p7` and their suites in the research repo, committed by the founder (they are untracked as of 2026-10-27).
- Founder decisions of 2026-10-27: a separate product repo; no hardware security key; an FSL-1.1-ALv2 engine licence; nothing gated behind a second person.
- Research background (research repo): the MVP plan's Definition of Done and first 30 days (`09` Findings 4 and 7); dependency-review results (`12` Finding 1).

## Milestone

M0 (week 0).

## Satisfies

NFR-07, NFR-08, NFR-09, NFR-12, NFR-13
