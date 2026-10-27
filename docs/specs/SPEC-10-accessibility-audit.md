# SPEC-10: Accessibility audit with two engines

## Purpose

Give accessibility evidence teams can act on, honestly bounded. It serves "accessibility audits take weeks, cost thousands and still leave us unsure" (UP-03): findings in minutes, with "checked, N need review" in place of a weeks-long audit's first pass. It never claims compliance. axe-core runs side by side with core's own engine as the reference used to validate and improve the own engine. Once the own engine checks every WCAG criterion axe-core checks, axe-core becomes an optional cross-check.

## Scope and non-goals

- **In:**
  - pinned, unmodified axe-core on every browser, as the reference for the own engine;
  - core's own ACT-based engine, with keyboard, focus and reflow probes, beside it on Chromium;
  - merged findings that name their engine;
  - the fix for the false positive on W3C ACT rule `bc4a75`;
  - walk caps reported as "can't tell" with a reason;
  - statuses pass, fail, needs-review and not-applicable;
  - a per-criterion map to WCAG 2.0, 2.1 and 2.2 AA;
  - an ACT re-score on the declared build;
  - **a coverage comparison per release:** the WCAG criteria checked by axe-core only, by the own engine only, and by both. axe-core stays on by default while any criterion is axe-only; it becomes an optional cross-check when none is. Which criteria an engine checks comes from the WCAG 2.2 test base (`docs/specs/SPEC-29-wcag-test-base.md`), not from rule tags.
- **Phase 2b (FR-43):**
  - further ACT rules, ordered by criterion impact and starting with the criteria only axe-core covers;
  - hand triage of engine disagreements on a sampled real-site corpus before any comparative claim.
- **Non-goals:** screen-reader automation; meaning and quality judgements (review queue only); Accessibility Conformance Report drafts (SPEC-26).

## Interfaces and types

```ts
export type WcagCriterionId = string;                       // success criterion number, e.g. "1.4.3"
export type A11yStatus = 'pass' | 'fail' | 'needs-review' | 'not-applicable';
export type A11yVerdict = 'findings-present' | 'no-automated-findings' | 'review-pending'; // no "compliant"
export type A11yFinding = {
  readonly ruleId: string; readonly engine: 'axe-core' | 'own';
  readonly actRuleId?: string;                              // W3C ACT rule id, e.g. "bc4a75"
  readonly wcag: readonly { successCriterion: WcagCriterionId; versions: readonly ('2.0' | '2.1' | '2.2')[] }[];
  readonly status: A11yStatus; readonly box: Box | null; readonly selector: string;
  readonly reason?: 'walk-cap' | 'engine-incomplete' | 'judgement-criterion';
};
export interface Auditor { audit(session: Session, mode: 'gate' | 'report'): Promise<readonly A11yFinding[]> }
export function mergeFindings(axe: readonly A11yFinding[], own: readonly A11yFinding[]): readonly A11yFinding[];
export type A11yRuleInfo = { readonly ruleId: string; readonly engine: 'axe-core' | 'own'; readonly criteria: readonly WcagCriterionId[] };
// Which WCAG criteria each engine checks in a release. It decides whether axe-core is still the reference.
export type EngineCoverageComparison = {
  readonly release: string; readonly axeVersion: string; readonly ownRulesetHash: string;
  readonly axeOnly: readonly WcagCriterionId[];
  readonly ownOnly: readonly WcagCriterionId[];
  readonly both: readonly WcagCriterionId[];
  readonly axeRole: 'reference' | 'optional-cross-check';  // 'optional-cross-check' only when axeOnly is empty
};
// Inputs come from the test base's coverage report (SPEC-29 engineRulesFromReport), not from rule tags.
export function compareEngineCoverage(axeRules: readonly A11yRuleInfo[], ownRules: readonly A11yRuleInfo[]): EngineCoverageComparison; // pure
```

## Acceptance criteria

- AC-SPEC-10-01: When the pinned ACT test cases run on the declared Chromium build, own-engine exact agreement shall be at least the accessibility-engine spike's baseline of 418 of 421 (oracle: regression; extends AC-p5-11).
- AC-SPEC-10-02: When both engines scan the 51 clean twins from the WCAG mapping spike (P1) and the `bc4a75` twins (`<table>` with `<caption>`, `<dl>`), neither shall report a failure (oracle: regression; extends AC-p5-14).
- AC-SPEC-10-03: When the 9 keyboard fixture pairs are scanned, each failure shall be found by its probe with no false positive on its clean twin (oracle: specified; reuses AC-p5-18).
- AC-SPEC-10-04: When a Tab walk or focus check hits its cap, the result shall list each unchecked element as `needs-review` with reason `walk-cap` (oracle: specified).
- AC-SPEC-10-05: When axe-core and the own engine both report the same node and criterion, the merged result shall hold one finding naming both engines (oracle: specified).
- AC-SPEC-10-06: When any output is generated, it shall contain no field or word asserting compliance or conformance (oracle: specified; claim lint).
- AC-SPEC-10-07: When a finding is emitted, it shall map to at least one WCAG success criterion with the versions it appears in (oracle: specified; reuses AC-p5-19).
- AC-SPEC-10-08: When a run audits accessibility, the manifest shall carry the axe-core version and the own engine's `rulesetHash` (oracle: specified).
- AC-SPEC-10-09: When an ACT rule is added in phase 2b, the re-score shall cover its test cases and no earlier rule's agreement shall fall (oracle: regression).
- AC-SPEC-10-10: When a comparative accessibility claim is drafted, it shall cite a triaged disagreement sample, or the claim lint shall fail (oracle: specified).
- AC-SPEC-10-11: When CI builds a release, it shall produce an `EngineCoverageComparison` listing the WCAG criteria checked by axe-core only, by the own engine only and by both. A release without one shall fail the build (oracle: specified).
- AC-SPEC-10-12: When the coverage comparison is produced, `axeRole` shall be `optional-cross-check` only if `axeOnly` is empty. Otherwise it shall be `reference`, and axe-core shall run by default (oracle: specified).
- AC-SPEC-10-13: When the coverage comparison is built, its inputs shall be the WCAG 2.2 test base's coverage report for the same release (SPEC-29), and a comparison built from rule tags alone shall fail the build (oracle: specified).

## Dependencies

- SPEC-06; SPEC-29 (the WCAG 2.2 test base the coverage comparison reads).
- The accessibility-engine spike's engine and harness (P5), and the WCAG mapping spike's criterion map (P1).
- Founder decision of 2026-10-27: axe-core stays side by side with the own engine.
- Research background: accessibility (`03`); independence and breadth (`12` Finding 3). ACT data is freely licensed [C-R17-007]. FTC order on compliance claims [C-R03-047].

## Milestone

M3; FR-43 in phase 2b.

## Satisfies

FR-10, FR-11, FR-43
