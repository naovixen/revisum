# SPEC-15: Metrics panel

## Purpose

Show a project where it stands on the way to "specs in, software out", from data core actually holds. It serves "we can't tell whether AI work gets through with less human checking, or just ships more defects" (UP-11): the share of checks that needed no person, measured, not guessed.

## Scope and non-goals

- **In:**
  - per run and per change class:
    - traced-criteria share (`tracedCriteriaShare`);
    - flaky-run rate (`flakyRunRate`);
    - verified-without-review share (`verifiedWithoutReviewShare`);
    - matrix cells run against declared (`matrixCoverage`; plan coverage and compatibility, RC-04 and RC-09);
    - review touches per change (`reviewTouches`), with a baseline from the first windows after adoption (measured AI use in testing, RC-23);
  - every other ladder metric shown as "not yet measured";
  - versioned formulas in the output schema;
  - a data table beside each chart.
- **Non-goals:** the level function (SPEC-21); escape data (SPEC-20); any grouping other than project and change class.

## Interfaces and types

```ts
export type MetricId =
  | 'tracedCriteriaShare' | 'flakyRunRate' | 'verifiedWithoutReviewShare' | 'matrixCoverage' | 'reviewTouches'
  | 'agentAuthoredShare' | 'specLinkedShare' | 'mutantsCaughtShare' | 'planApprovalsPerChange'
  | 'unreviewedMergeShare' | 'escapedDefects';
export type MetricValue =
  | { id: MetricId; status: 'measured'; value: number; sampleSize: number; confidenceInterval: [number, number];
      formulaVersion: `v${number}`; declared: boolean }                       // declared: rests on a declared approval
  | { id: MetricId; status: 'not-yet-measured'; needs: 'tracker' | 'mutants' | 'holdout' | 'deployment-source' };
export type MetricWindow = { changeClassId: string; start: string; end: string };
export function computePanel(history: readonly RunRecord[], metricWindow: MetricWindow): readonly MetricValue[]; // pure
```

## Acceptance criteria

- AC-SPEC-15-01: When `computePanel` runs on a fixture history, `tracedCriteriaShare`, `flakyRunRate`, `verifiedWithoutReviewShare`, `matrixCoverage` and `reviewTouches` shall equal a hand count (oracle: specified).
- AC-SPEC-15-02: When a metric has no data source, the panel shall show `not-yet-measured` with what it needs, never zero (oracle: specified).
- AC-SPEC-15-03: When the panel is computed twice from the same history, the output shall be identical (oracle: metamorphic).
- AC-SPEC-15-04: When a window holds fewer changes than the minimum, the panel shall show the interval and flag the sample as small (oracle: specified).
- AC-SPEC-15-05: When a chart is rendered, a data table with the same numbers shall accompany it (oracle: specified; reuses AC-p6-17).
- AC-SPEC-15-06: When `verifiedWithoutReviewShare` is shown, it shall count only person-verified and person-declared decisions as human touches, show the declared and unverified counts beside it, and mark the value `declared` when any declared decision counts (oracle: specified).
- AC-SPEC-15-07: When `planApprovalsPerChange` or `unreviewedMergeShare` is shown, approvals and holdout gates resting on declared approvals shall count exactly as verified ones and mark the value `declared`; no metric shall read zero or `not-yet-measured` for want of a verified approval or a second person (oracle: specified).

## Dependencies

- SPEC-13, SPEC-14.
- Research background: maturity and roles (`10` Findings 1, 4 and 6). No standard defines flaky rate [C-R15-049].

## Milestone

M3.

## Satisfies

FR-20
