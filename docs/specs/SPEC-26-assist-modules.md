# SPEC-26: Assist modules

## Purpose

Help with the judgement work core can't own: drafts and candidates that a person decides on. It serves "accessibility audits take weeks, cost thousands and still leave us unsure" (UP-03) with Accessibility Conformance Report (ACR) drafts, and "manual regression before every release holds the release up" (UP-05) with risk-sized regression. It supports the judgement and communication work that stays human (RC-27) with documentation.

## Scope and non-goals

- **In:**
  - ACR rows and an EU-model accessibility statement drafted from findings, with review-queue criteria marked "not evaluated";
  - an exploration mode crawling non-production origins with implicit oracles (crash, console error, accessibility rule, metamorphic reload), its findings `proposed` only;
  - risk-based depth and plan selection by declared change impact;
  - a test-approach page per project.
- **Non-goals:** signing an ACR; usability verdicts; any data about people.

## Interfaces and types

```ts
// One row of an Accessibility Conformance Report draft; a person reviews and signs the report.
export type ConformanceReportRow = {
  successCriterion: WcagCriterionId; level: 'A' | 'AA';
  conformance: 'supports' | 'partially-supports' | 'does-not-support' | 'not-evaluated';
  remarks: AiText | null; evidence: readonly string[];
};
export type ExplorationFinding = Finding & { status: 'needs-review'; proposed: true };
export type ImpactMap = Readonly<Record<string /* path glob */, readonly string[] /* plan ids */>>;
export function selectPlans(changedPaths: readonly string[], map: ImpactMap, risk: RiskClass): readonly string[];
```

## Acceptance criteria

- AC-SPEC-26-01: When an ACR draft is built, any criterion with an undecided review item shall be `not-evaluated`, never `supports` (oracle: specified).
- AC-SPEC-26-02: When exploration finds an issue, it shall reach the review queue as `proposed` and never fail or pass a run by itself (oracle: specified).
- AC-SPEC-26-03: When `selectPlans` runs, every plan mapped to a changed path shall be selected, and high-risk classes shall select all plans for the class (oracle: specified).
- AC-SPEC-26-04: When the test-approach page is regenerated from unchanged inputs, it shall be byte-identical and contain no person's name (oracle: metamorphic).

## Dependencies

- SPEC-10, SPEC-13, SPEC-20.
- Research background: API and integration (`05` Finding 7); maturity and roles (`10` Finding 6). AI VPAT tools require sign-off [C-R06-044]; scenario exploration fell short of manual testing [C-R15-086].

## Milestone

Phase 3, on request.

## Satisfies

FR-39, FR-40, FR-41, FR-42
