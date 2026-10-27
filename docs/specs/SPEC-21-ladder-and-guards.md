# SPEC-21: Ladder v0 and guards

## Purpose

Compute each change class's level on the Level 0–5 maturity ladder (research `10`) from evidence, with guards that make the level hard to game. The ladder serves the Level 5 goal, "specs in, software out" (FD-1), and tests whether a team's level can be computed from its own data (H14). It serves "we can't tell whether AI work gets through with less human checking, or just ships more defects" (UP-11): a project sees where each change class stands and what blocks the next rung.

## Scope and non-goals

- **In:**
  - a pure `levelAt` per change class and window over nine metrics, each named in full:
    - `agentAuthoredShare` (A);
    - `specLinkedShare` (S);
    - `tracedCriteriaShare` (T);
    - `mutantsCaughtShare` (M, check strength);
    - `verifiedWithoutReviewShare` (V);
    - `planApprovalsPerChange` (P);
    - `unreviewedMergeShare` (U);
    - `flakyRunRate` (F);
    - `escapedDefects` (E);
  - core's published default thresholds, with custom thresholds labelled "custom";
  - window rules: one failing window lowers the level, and moving up needs the full count;
  - a cap at Level 3 without an escape source;
  - **a check-strength guard.** `mutantsCaughtShare` measures it, and removing a check is an audited event that restarts gating;
  - **core's own browser mutants**, made by response rewriting on fixture origins through the egress proxy (SPEC-07): element removed, text changed, status flipped, field ignored. The protocol mutants (SPEC-23) join for API classes in phase 2b;
  - **the ladder's guards (research `10`):**
    - N windows (default 4);
    - a minimum number of changes per window;
    - classes that partition all merged changes;
    - windows fixed in advance;
    - change fail rate and rework rate for Levels 4–5;
  - `mutantsCaughtShare` absent gives a `partial` label and no level above 3;
  - levels resting on declared inputs (agent authorship, or approvals under agent lock-down) are labelled `declared`;
  - high-risk classes, declared in trusted config, need an approved extra review (SPEC-02); the owner's declared approval under agent lock-down suffices, so no class waits for a second person (founder, 2026-10-27);
  - **the independent verifier** for Levels 4–5 is holdout plans the building agent can't edit (SPEC-22): independent of the agent, not a second human. Levels 4–5 may be reached with declared holdouts and approvals, labelled `declared`; no level requires a verified approval;
  - free and local.
- **Non-goals:** any grouping other than project and change class; hosted trends (SPEC-24).

## Interfaces and types

```ts
export type Level = 0 | 1 | 2 | 3 | 4 | 5;
export type WindowMetrics = {
  changeClassId: string; start: string; end: string; changes: number;
  agentAuthoredShare: number; specLinkedShare: number; tracedCriteriaShare: number;
  mutantsCaughtShare: number | null;                        // null when no mutant score exists for the window
  verifiedWithoutReviewShare: number; planApprovalsPerChange: number; unreviewedMergeShare: number; flakyRunRate: number;
  escapedDefects: Readonly<Record<Severity, number>> | null; changeFailRate: number | null; reworkRate: number | null;
  declaredInputs: readonly MetricId[];                      // metrics resting on declared data
};
export type LevelResult = { level: Level; label: 'default' | 'custom' | 'declared' | 'partial'; blockedBy: readonly string[];
  capReason?: 'no-escape-source' | 'no-mutant-score' | 'small-window' };
export type WindowPlan = Brand<{ starts: readonly string[]; lengthDays: number }, 'WindowPlan'>;   // fixed in trusted config
export type BrowserMutant = { id: string; origin: Origin; kind: 'remove-element' | 'change-text' | 'flip-status' | 'ignore-field'; selector: string };
export function levelAt(history: readonly WindowMetrics[], thresholds: Thresholds): LevelResult; // pure
export type RiskClass = 'authentication' | 'deletion' | 'personal-data' | 'migration' | 'accessibility' | 'standard';
```

## Acceptance criteria

- AC-SPEC-21-01: When property tests probe each threshold at, just below and just above its boundary, `levelAt` shall return the level the published ladder defines (oracle: specified; extends AC-p6-16).
- AC-SPEC-21-02: When the escape source is absent, the level shall never exceed 3 and shall carry `capReason` (oracle: specified).
- AC-SPEC-21-03: When any threshold differs from the defaults, the result label shall be `custom` (oracle: specified).
- AC-SPEC-21-04: When a check is removed or downgraded, an audit event shall be written and gating shall restart (oracle: specified).
- AC-SPEC-21-05: When a change in a high-risk class has no recorded extra review, core's verdict shall be `needs-review`, never pass (oracle: specified).
- AC-SPEC-21-06: When a level rests on a declared input, such as agent authorship or an approval under agent lock-down, the label shall be `declared` (oracle: specified).
- AC-SPEC-21-07: When `mutantsCaughtShare` is null for a window, the result shall be labelled `partial`, never exceed Level 3, and carry `no-mutant-score` (oracle: specified).
- AC-SPEC-21-08: When a seeded browser mutant runs against a class's plans and no plan fails, `mutantsCaughtShare` shall fall and the mutant shall be listed as surviving (oracle: specified).
- AC-SPEC-21-09: When a window has fewer changes than the minimum, it shall not count toward the window count and shall carry `small-window` (oracle: specified).
- AC-SPEC-21-10: When the declared classes don't cover every merged change, or overlap, `levelAt` shall refuse to place any class (oracle: specified).
- AC-SPEC-21-11: When Level 4 or 5 is tested and change fail rate or rework rate is null, the level shall stay below 4 (oracle: specified).
- AC-SPEC-21-12: When the window plan or a threshold changes, gating shall restart and an audit event shall be written (oracle: specified).
- AC-SPEC-21-13: When a high-risk change's only extra review is the maintainer's declared approval under agent lock-down, the verdict shall be able to pass, labelled `declared`, with no second account (oracle: specified; solo fixture repository).
- AC-SPEC-21-14: When a class meets Level 4's or Level 5's criteria and every holdout plan and approval behind them is declared, `levelAt` shall place it at that level with label `declared`, and shall never lower it or set `blockedBy` for want of a verified approval or a second person (oracle: specified).
- AC-SPEC-21-15: When Level 5's unreviewed-merge criterion is tested, each counted merge shall need a passing run of a holdout plan outside the building agent's write scope (SPEC-22); the number of people who approved shall not enter the computation (oracle: specified).

## Dependencies

- SPEC-07 (mutant hook), SPEC-15, SPEC-20, SPEC-02 (extra review). The protocol mutants (SPEC-23) join in phase 2b but are not needed to start.
- Research background: maturity and roles (`10` Findings 1, 2 and 5). Metrics set as targets get gamed [C-R15-026]; level gating [C-R15-014].

## Milestone

Phase 2a.

## Satisfies

FR-30, FR-32, FR-33
