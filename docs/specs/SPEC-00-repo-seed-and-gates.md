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
    - The coding agent is locked out of push, merge, history rewriting and pull-request approval by deny rules in its settings. It may commit locally (founder decision, 2026-10-27; `docs/decisions/single-session-workflow.md`).
    - The founder pushes and merges personally. Only the default branch is trusted.
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

**Build notes.** Points the criteria leave open for the remaining criteria, settled from this spec's scope, `CONTRIBUTING.md`, `START.md` and `docs/decisions/` (2026-10-29). The founder settled how the guarantee map treats rows whose tests come later.

- **Where each check runs.**
  - Checks that read only files go in `npm run lint`, so the scratch-copy lint tests in `test/proofs/` exercise them. They must not need Git: the scratch copy is not a repository.
  - Checks that need test outcomes or Git history run in a new last step of `npm run check`, `npm run gates`, after `npm run replay`.
  - Test outcomes: `tools/run-test-folder.ts` adds a reporter module from `tools/` that writes one JSON line per test (file, full name with suite names joined by ` > `, line, passed, duration) to `.test-results/`, which Git ignores. A test id is `<file>#<full name>`. A test's criterion is read from its source at the reported line, as the naming lint reads it.
  - `DependencyReview`, `DependencyCheck`, `GuaranteeRow`, `GuaranteeMap` and `SeedProvenance` live in `tools/`, beside the checks that use them: they describe this repository's build, and no package imports them. `TEST_SET` stays in `tools/check-tests-apart.ts`.
  - The root configuration the gates need (`package.json` scripts, `.gitignore`, `licences.json`, `.github/workflows/ci.yml`) changes in the code commit, as earlier specs' code commits did. CODEOWNERS gives `.github/` to the founder, who reads it before pushing.
  - Tests never write to the real `node_modules`: the scratch copy links it.
- **Dependency reviews (AC-SPEC-00-04).**
  - `tools/dependency-reviews.ts` holds one typed `DependencyReview` per component, transcribed from `docs/decisions/browser-and-audit-dependencies.md`: `axe-core` 4.14.0 `default`, and `playwright-core` 1.64.1 `optional-adapter`.
  - The trust path is every package that `package-lock.json` installs as a non-development dependency of a workspace package. Today that is those two. Development-only packages (`typescript`, `@types/node`, `@puppeteer/browsers`) are off it. Browser builds are locked by SPEC-05, not here.
  - The lint fails when such a package has no review; when the review's version is not the exact version in the lock file and in every manifest; when a check is `fail` and the decision is `default`; or when an evidence entry that is a repository path does not exist. `partial` does not fail.
  - Tests: scratch-copy lint with a planted dependency that has no review, and with a `default` review given a `fail`.
- **Tests apart (AC-SPEC-00-05).**
  - Built: `tools/check-tests-apart.ts` and the pull-request job.
  - Add a mode that checks each commit of a range on its own (`--commits <from>..<to>`). CI runs it on every push to `main`, because commits reach `main` without a pull request. No commit in history mixes the two today.
  - Tests: mixed, tests-only and code-only path lists, and a scratch Git repository holding one mixed commit.
  - Waits for beta: branch protection can't require the check on GitHub Free. Until then the branch-gates check (AC-SPEC-00-20) proves, on recorded JSON, that `ci` and `tests-apart` are both required.
- **Commit trailers and metrics (AC-SPEC-00-07).**
  - Grammar. Keys are exact, one value per line, in Git's trailer block:
    - `Agent: claude-code/<version>`, at most once. The version is the one `claude --version` prints, such as `2.1.312`. The tool part matches `[a-z][a-z0-9-]*`; the version is semantic.
    - `Spec: SPEC-nn`, once per spec. It must name a file in `docs/specs/`.
    - `Criteria: AC-SPEC-nn-mm[, AC-SPEC-nn-mm]`. Each id must exist in `docs/specs/`.
  - A commit is malformed when a value breaks its grammar or names something that doesn't exist; when a key is a near miss (`agent:`, `Specs:`, `Criterion:`); or when it carries a `Co-Authored-By:` trailer naming Claude but no `Agent:`. Other trailers are ignored.
  - Cut-over. Commits up to and including the one that adds these notes carry no `Agent:` trailer and can't be rewritten (amending and rebasing are denied). The tool records that commit's hash. The malformed check and all three commit metrics cover only its descendants, and the output counts the earlier commits as `beforeTrailers`. From the next commit on, the main session adds all three trailers.
  - A malformed commit can't be amended. So the main session checks each message before committing (`node tools/check-commit-trailers.ts --message <file>`). A malformed commit already made is listed, with its reason, in a known-exceptions list in the tool by a later commit, which the founder reads.
  - `agentAuthoredShare` is commits with `Agent:` over commits since the cut-over; `specLinkedShare` is commits with `Spec:` or `Criteria:` over the same.
  - `tracedCriteriaShare` is criterion ids in `docs/specs/` with at least one passing tagged test in this run, over all criterion ids in `docs/specs/`, with a per-spec breakdown.
  - `flakyRunRate` for one run is 0 or 1, as SPEC-27's `RunRecord.flakyPair`. When a test file fails, `run-test-folder` reruns it once, only to measure. The run still fails (no retries), and it is flaky if the rerun passes. Rates over many runs are SPEC-15's.
  - Output: `.test-results/project-metrics.json` (a `RunRecord`, the four metrics and `approvalStrength: 'declared'`) and a Markdown summary. The `ci` job checks out full history (`fetch-depth: 0`). On push to `main` it appends the summary to the job summary and uploads `.test-results/` as an artefact: action pinned by commit hash, kept 90 days, well inside the free quota.
  - Tests: scratch Git repositories built by the test, with fixture commits and a fixture results file. Each share equals a hand count; a malformed trailer fails.
- **Licences (AC-SPEC-00-08).**
  - Built: `tools/check-licences.ts` matches each package's `license` to `licences.json`.
  - Add a `roles` map to `licences.json`. The check requires Apache-2.0 for `schema`, `sdk`, `driver` and `adapter`, and FSL-1.1-ALv2 for `engine`; `product` may carry either. Roles today: `contracts` schema; `driver-cdp` and `driver-playwright` driver; `auditor-axe` and `report` adapter; `action` sdk; `engine` engine; `auditor-act`, `runner` and `cli` product (FSL by choice).
  - Every tracked `*.schema.json` (today `docs/plan-language/plan.schema.json`) is listed in `licences.json` as Apache-2.0; an unlisted one fails.
  - axe-core is pinned at 4.14.0. `licences.json` records the sha256 of its MPL-2.0 files `axe.js` and `axe.min.js`, as the vendor publishes them in `sri-history.json` for 4.14.0. The check fails when an installed file's hash differs, when the installed version is not the pinned one, or when a file under `packages/` is a copy of an `axe*.js` file. The installed files match today.
  - The check takes the installed-packages folder as an option (default `node_modules`), so tests point it at a fixture folder holding an edited copy.
- **Cost report (AC-SPEC-00-09).**
  - There is no hosted service and no billing access, so spend is a declared record: `docs/costs/hosted-costs.json` holds the month, the customer count (0) and one line per hosted service (service, plan, monthly USD, `source: 'declared'`). Today: GitHub Free, private repository, Actions inside the free minutes, USD 0.
  - `npm run cost-report` (`node tools/cost-report.ts`) prints the month's report and fails when the total is over USD 5 while customers is 0. The lint runs the same check, so a committed record over budget fails CI. Nothing reads an account or an API.
  - The founder updates the record monthly and whenever a paid service is added.
  - Tests: scratch-copy lint with a record totalling USD 5.01, and one at exactly USD 5.
- **Guarantee map (AC-SPEC-00-10).**
  - `tools/guarantee-map.ts` holds the `GuaranteeMap`. Each row has its test id, the class shown when that test passes, and a weaker class shown when it is missing or fails (by default "claimed, not proven by CI").
  - The gates step fails when a mapped test id is in no result or didn't pass, and writes `.test-results/guarantees.md` showing each row's class for that run.
  - The published table is `docs/guarantees.md`, generated with `--write` from a green run. The gates step fails when it differs from what the run generates, as the schema check does.
  - Classes when proven: `ai-output-only-as-plan` runtime-checked; `known-actions-only` structural, for plans without unsafe features; `lifecycle-no-skip` type-level; `declared-log-fields` structural, for field names only; `targets-not-substituted`, `pii-masked-in-pixels`, `same-inputs-same-result` and `browser-egress-allow-list` runtime, partial (egress is enforced by SPEC-07); `secrets-absent` type-level, runtime-partial for echoes; `adapters-substitutable` runtime; `report-runs-no-content` type-level and runtime; `person-approval` runtime-checked, recorded as declared; `no-pii-in-reports`, `actions-tamper-evident` and `spec-to-commit-trace` runtime.
  - Every row has a passing test to map today except three, which have none until M3: `no-pii-in-reports` (SPEC-09 and SPEC-12), and `actions-tamper-evident` and `spec-to-commit-trace` (SPEC-14).
  - Those three rows are marked pending, each with the specs that will give it a test (founder, 2026-10-29). A pending row shows its weaker class and doesn't fail the gates step until every one of its specs is ticked in `START.md`; from then on it fails like any other row when its test is missing or fails. A pending mark on a row whose specs are all ticked fails the step, so the mark can't outlive its reason.
  - Tests: a fixture results file where one mapped test fails, and one missing a mapped id. Both fail, and the run's table shows the weaker class. A pending row with an unticked spec passes and shows its weaker class; the same row once its specs are ticked fails.
- **Seeding (AC-SPEC-00-11).**
  - Seeded 2026-10-28; `seed-provenance.json` records 676 sources for 672 files. Four files were merged from two prototype files each; the second source sits in that entry's `mergedFrom` list, so every seeded prototype file stays on record and `to` stays unique. Seeded code has changed since (60 package files differ from their source hash), so hashes are compared only while seeding.
  - Add `tools/seed-from-research.ts --research <repository> --commit <hash> --files <list>`. It copies each file from that commit with `git show`, writes `seed-provenance.json`, and fails, naming the file, when the commit lacks it. It names no research path itself; the repository is an argument.
  - The lint adds a shape check of `seed-provenance.json`: a 40-hex commit, 64-hex hashes (including `mergedFrom` sources), unique `to` paths inside this repository, and `reusedCriteria` spec ids that exist in `docs/specs/`.
  - Tests: a scratch Git repository built by the test stands in for the research repository.
- **Criterion ids (AC-SPEC-00-15).**
  - Built: the naming lint rejects a criterion id anywhere but a test's `criterion` value.
  - Add: a `criterion` value must name a criterion in `docs/specs/`.
  - The trace index is `.test-results/trace-index.json` (criterion, test ids, outcome), written by the gates step. It is generated, never committed, so the lint never reads it. Trailers live in Git, not in files.
  - Tests: scratch-copy lint with an id planted in a code string and in a comment, and with a test naming `AC-SPEC-99-01`.
- **Glossary (AC-SPEC-00-16).**
  - `tools/check-glossary.ts` runs in the lint. Code names are the backticked tokens in the "Code name" column of the Domain terms and Metrics tables.
  - A token resolves when it is an exported declaration in `packages/*/src` or `tools/`; a string literal or property name declared in `packages/*/src` (step names, union members such as `runTimers`); or, when it holds `/` or a file extension, a tracked path. Tokens of other shapes, such as JSON examples, are skipped.
  - A row whose "Where" says only "planned" is skipped; a partly planned row ("exists; driver planned") is checked. The "All are planned" line under Metrics and the "planned, SPEC-00" entries are updated as these land.
  - The core package's public API is every type and interface exported from `packages/engine/src/index.ts`, following `export *` into `contracts`, which the engine re-exports. About 160 are missing from the glossary today; the code commit adds rows, one family per row. Sources are read as text: TypeScript 7 has no stable compiler API.
  - The Standard names table must equal `standardNames` in `tools/naming-lint-config.ts`.
  - Tests: scratch-copy lint with a row naming a missing export, an exported engine type taken out of the glossary, and a standard name dropped.
- **Research links (AC-SPEC-00-17).**
  - Built: the naming lint bans spike names and research citations in comments.
  - Add `tools/check-research-links.ts` to the lint. It fails when a tracked file other than `*.md`, `docs/**` and `seed-provenance.json` holds `docs/research/`, a path into the research repository (`E:\core`, `E:/core`) or any `from` path of the record. It also fails when any tracked file except `seed-provenance.json`, docs included, holds the research commit or a prefix of it of 7 or more characters. Both pass today.
  - Tests: scratch-copy lint planting each.
- **Deny rules and declared approvals (AC-SPEC-00-19).**
  - This spec's scope and the founder's decision of 2026-10-27 (`docs/decisions/single-session-workflow.md`) let the agent commit, and SPEC-02's lock-down route requires push, merge and pull-request-approval denials. So the check requires those three, through the engine's `parseDenyRules` and `deniesRequiredActions` (exported from the engine for the tool), plus this repository's history denials: amend, `--no-verify`, rebase, tag and `reset --hard`. The criterion's "commit" is met by denying commits that rewrite history or skip hooks, not ordinary commits.
  - It reads `.claude/settings.json` from the working tree, in the lint; on a push to `main`, that is the default branch's copy.
  - Declared: `project-metrics.json` carries `approvalStrength: 'declared'`, and the summary says the approval is the founder's push under the agent lock-down, declared and not verified.
  - Tests: scratch-copy lint with each required denial removed in turn.
- **Branch gates (AC-SPEC-00-20).**
  - `tools/check-branch-gates.ts --rules <file> [--protection <file>] [--require-checks]` reads GitHub's JSON for a branch's rules and its classic protection.
  - It fails when any rule or protection requires an approving review (a count of 1 or more), a code-owner review or last-push approval, or requires a status check that `ci.yml` doesn't produce. With `--require-checks` it also fails unless `ci` and `tests-apart` are required (AC-SPEC-00-05).
  - Fixtures in `fixtures/branch-gates/`: the planned beta ruleset (passes), and one each with a review count of 1, a code-owner review and an unknown required check (each fails). `main` has neither rules nor protection today, so empty JSON passes.
  - Waits for beta: a CI step that fetches the live rules with the job's token. The rules endpoint needs read access only; classic protection needs an admin token, so beta protects `main` with a ruleset. The agent can't read either locally (`gh api` is denied).

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
