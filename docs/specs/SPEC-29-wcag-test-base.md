# SPEC-29: WCAG 2.2 test base for the accessibility engines

## Purpose

Make "which WCAG criteria does core check, and how well" a published, reproducible number instead of a claim. It serves "accessibility audits take weeks, cost thousands and still leave us unsure" (UP-03): each release states per level and per engine how many success criteria it verifies, and its precision and recall on fixtures never used for tuning. The test base is data: one row per WCAG 2.2 success criterion at every level, with one generic runner. The axe-core switch rule in SPEC-10 reads from it. Legal claims stay WCAG 2.2 AA (research `03`); AAA results are reported, labelled beyond the legal target.

## Scope and non-goals

- **In, phase 1 (M3):**
  - **Rows for every level.** One row per WCAG 2.2 success criterion that has a conformance level: 86, of which 31 are A, 24 AA and 31 AAA, with 4.1.1 obsolete and reported "not evaluated" [C-F5-001]. The list is pinned from the W3C machine-readable criteria and hashed into the manifest.
  - **Each row records:**
    - its level and WCAG versions;
    - an automation status: `full` (an engine can decide pass and fail), `partial` (an engine decides some failures; a judgement gap remains) or `judgement` (review queue only);
    - the mapped W3C ACT rules, axe-core rules and own-engine rules;
    - fail and pass fixture pairs used for building and tuning;
    - a held-out fixture set never used for tuning.
  - **One generic runner** that iterates over the rows and runs every fixture through both engines. Adding a row or fixture is a data change, not a code change.
  - **Existing evidence as rows of the same data:**
    - the pinned W3C ACT test cases, each as a case of its rule's criteria;
    - the WCAG mapping spike's 51 fixture pairs (P1);
    - the accessibility-engine spike's 9 keyboard pairs (P5);
    - the `bc4a75` twins.
  - **Fixtures for A and AA:** every A and AA row rated `full` or `partial` gets at least one tuning pair and one held-out pair.
  - **A coverage report in CI per release.** It gives "verifies N of M criteria" per level and per engine, plus held-out precision and recall per engine. `partial` rows count as "checks part of", never as verified.
- **Phase 2a:** fixtures and held-out pairs for the AAA rows rated `full` or `partial`.
- **Non-goals:**
  - any compliance or conformance statement (SPEC-10, claim lint);
  - fixtures for `judgement` rows, which route to the review queue;
  - real-site precision (SPEC-10, FR-43);
  - WCAG 3.0.

## Interfaces and types

```ts
// WcagCriterionId, A11yStatus and A11yRuleInfo: SPEC-10. Brand: SPEC-27.
export type WcagLevel = 'A' | 'AA' | 'AAA';
export type AutomationStatus = 'full' | 'partial' | 'judgement';
export type EngineName = 'axe-core' | 'own';
export type FixtureId = Brand<string, 'FixtureId'>;
export type FixtureOrigin = 'act-test-case' | 'mapping-pair' | 'keyboard-pair' | 'engine-twin' | 'written-for-base';
export type FixtureCase = {
  readonly id: FixtureId; readonly path: string; readonly sha256: string;
  readonly expected: 'fail' | 'pass' | 'not-applicable';
  readonly origin: FixtureOrigin; readonly actRuleId?: string;
};
export type CriterionRow = {
  readonly criterion: WcagCriterionId; readonly level: WcagLevel;
  readonly versions: readonly ('2.0' | '2.1' | '2.2')[];
  readonly automation: AutomationStatus;
  readonly actRules: readonly string[]; readonly axeRules: readonly string[]; readonly ownRules: readonly string[];
  readonly tuning: readonly FixtureCase[];
  readonly heldOut: readonly FixtureCase[];         // never read by engine code, engine tests or tuning scripts
};
export type TestBase = { readonly wcagListSha256: string; readonly rows: readonly CriterionRow[] };
// Per row and engine: verifies only for a 'full' row whose every fixture the engine gets right.
export type CriterionOutcome = 'verifies' | 'checks-part' | 'none';
export type CoverageReport = {
  readonly release: string; readonly testBaseSha256: string; readonly axeVersion: string; readonly ownRulesetHash: string;
  readonly perLevel: Readonly<Record<WcagLevel, {
    readonly total: number;
    readonly perEngine: Readonly<Record<EngineName | 'either', { readonly verifies: number; readonly checksPart: number }>>;
  }>>;
  readonly heldOut: Readonly<Record<EngineName, { readonly cases: number; readonly precision: number | null; readonly recall: number | null }>>;
  readonly outcomes: readonly { readonly criterion: WcagCriterionId; readonly engine: EngineName; readonly outcome: CriterionOutcome }[];
  readonly beyondLegalTarget: readonly ['AAA'];      // labelled so in every rendering
};
export function runTestBase(base: TestBase, engines: Readonly<Record<EngineName, Auditor>>): Promise<CoverageReport>;
// Feeds SPEC-10's compareEngineCoverage: an engine covers a criterion only if its outcome is not 'none'.
export function engineRulesFromReport(report: CoverageReport): readonly A11yRuleInfo[]; // pure
```

## Acceptance criteria

- AC-SPEC-29-01: When the test base loads, it shall hold exactly one row per success criterion with a level in the pinned W3C list (86: 31 A, 24 AA, 31 AAA [C-F5-001]). A missing, duplicate or unknown criterion, or a list hash that differs from the manifest, shall fail CI (oracle: specified).
- AC-SPEC-29-02: When a row or fixture is added as data only, the runner shall include it in the next report with no code change (oracle: specified; test adds a fixture row and diffs the report).
- AC-SPEC-29-03: When the pinned W3C ACT test cases run as rows, the own engine's exact agreement shall equal SPEC-10's ACT re-score on the same build (oracle: regression; at least 418 of 421, AC-SPEC-10-01).
- AC-SPEC-29-04: When the WCAG mapping spike's pairs, the keyboard pairs and the `bc4a75` twins run as rows, the results shall equal those of AC-SPEC-10-02 and AC-SPEC-10-03 (oracle: regression).
- AC-SPEC-29-05: When any engine source, engine test or tuning script references a held-out fixture id or path, lint shall fail. A pull request that changes held-out fixtures and any other file shall fail the `tests-apart` check (oracle: specified; SPEC-00).
- AC-SPEC-29-06: When CI builds a release, it shall publish a `CoverageReport` with "verifies N of M" and "checks part of K" per level and per engine, and held-out precision and recall per engine. A release without one shall fail the build (oracle: specified).
- AC-SPEC-29-07: When a row's automation status is `partial` or `judgement`, no engine shall be counted as verifying it. `judgement` rows shall produce review-queue items only (oracle: specified).
- AC-SPEC-29-08: When SPEC-10's `compareEngineCoverage` runs, its input shall come from `engineRulesFromReport`, so a criterion counts as axe-only only if axe-core's outcome is `verifies` or `checks-part` and the own engine's is `none`. Rule tags alone shall not count (oracle: specified).
- AC-SPEC-29-09: When any output shows AAA results, it shall label them "beyond the legal target". The claim lint shall fail any AAA wording that implies a legal or conformance claim (oracle: specified).
- AC-SPEC-29-10: When M3 exits, every A and AA row rated `full` or `partial` shall have at least one tuning pair and one held-out pair. In phase 2a, the same shall hold for AAA rows (oracle: specified).
- AC-SPEC-29-11: When the runner runs twice on the same test base, engines and Chromium build, the two reports shall be byte-identical (oracle: metamorphic).
- AC-SPEC-29-12: When the held-out set has no failing case for an engine, precision or recall shall be `null` and shown as "not measured", never as 0 or 100% (oracle: specified).

## Dependencies

- SPEC-10 (engines, `Auditor`, `compareEngineCoverage`), SPEC-00 (`tests-apart`, CODEOWNERS on fixtures), SPEC-08 (manifest), SPEC-17 (claim lint).
- The WCAG mapping spike's criterion map and fixtures (P1), and the accessibility-engine spike's ACT harness and keyboard fixtures (P5), copied with source hashes.
- Founder decision of 2026-10-27: a data-driven WCAG 2.2 test base covering A, AA and AAA.
- Research background: accessibility (`03` Findings 3 and 4); independence and breadth (`12` Finding 3). WCAG 2.2 advises against requiring AAA as a general policy [C-F5-002].

## Milestone

M3 (data structure, runner, coverage report for every level; fixtures for A and AA); phase 2a (AAA fixtures).

## Satisfies

FR-49
