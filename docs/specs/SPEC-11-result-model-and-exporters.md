# SPEC-11: Result model and exporters

## Purpose

One typed, hashed result per run is the source of truth; every other format is a pure projection of it. It serves "manual regression before every release holds the release up" (UP-05) and "bug reports don't show what broke, where, or how bad it is" (UP-06): CI systems read the verdict natively, and every finding carries the evidence a developer needs (evidence-rich findings, R12).

## Scope and non-goals

- **In:** the `<namespace>.result/v1` schema; the evidence-rich finding set (masked annotated screenshot with a problem box, P1–P4 severity with its impact basis, steps, target, request and response excerpts or logs); the published severity scale (research `10`), with core's proposal and a recorded override; exporters to JUnit XML, SARIF 2.1.0 (Static Analysis Results Interchange Format) and a Markdown job summary; fixed CLI exit codes; timings outside the result hash.
- **Non-goals:** CTRF (on request); the HTML report and PR comment (SPEC-12).

## Interfaces and types

```ts
export type Severity = 'P1' | 'P2' | 'P3' | 'P4';
// A short, redacted extract of one side of an HTTP exchange, kept as finding evidence.
export type HttpExcerpt = { readonly startLine: string; readonly headers: Readonly<Record<string, string>>; readonly bodyExcerpt: string | null };
export type Finding = {
  readonly id: string; readonly targetId: TargetId; readonly criterionId: CriterionId | null;
  readonly severity: Severity | 'unrated'; readonly severityBasis: string;   // the user impact the severity rests on
  readonly screenshot: ArtifactReference | null; readonly box: Box | null;    // masked capture only
  readonly steps: readonly string[];                                         // at least 2
  readonly exchange?: { request: HttpExcerpt; response: HttpExcerpt };       // redacted
  readonly logs?: readonly string[];
  readonly status: 'fail' | 'needs-review';
};
export type PlanReference = { readonly path: string; readonly planHash: string };
export type Summary = { readonly verdict: 'passed' | 'failed' | 'rejected' | 'target-unavailable' | 'needs-review';
  readonly passed: number; readonly failed: number; readonly needsReview: number; readonly skipped: number };
export type TargetResult = { readonly targetId: TargetId; readonly testedOn: string;
  readonly status: 'passed' | 'failed' | 'unavailable' | 'skipped'; readonly unavailable?: Unavailable;
  readonly findings: readonly Finding[]; readonly reviewItems: readonly ReviewItem[] };
export type SarifLog = { readonly version: '2.1.0'; readonly $schema: string; readonly runs: readonly unknown[] }; // SARIF 2.1.0 document
export type RunResult = { schema: `${string}.result/v1`; runId: string; plan: PlanReference; summary: Summary; targets: readonly TargetResult[] };
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5; // passed, failed, rejected, required target unavailable, internal, needs review
export const EXIT_PRECEDENCE: readonly ExitCode[] = [4, 2, 3, 1, 5, 0]; // highest first: one run, one code
export const toJUnit: (result: RunResult) => string;
export const toSarif: (result: RunResult) => SarifLog;
export const toSummaryMarkdown: (result: RunResult) => string;
```

## Acceptance criteria

- AC-SPEC-11-01: When a finding lacks a screenshot or box where one is available, a severity basis, two steps, a target, or, where its step made a network exchange or wrote logs, the redacted request and response excerpts or the logs, the finding type guard shall reject it (oracle: specified; extends AC-p6-11).
- AC-SPEC-11-02: When an exporter runs twice on the same result, its output shall be byte-identical, and the golden files shall match (oracle: regression).
- AC-SPEC-11-03: When a finding is `needs-review`, SARIF shall carry it as a note, never as an error or a pass (oracle: specified).
- AC-SPEC-11-04: When a required target is unavailable, JUnit shall report an error; when an optional one is, it shall report skipped (oracle: specified).
- AC-SPEC-11-05: When timings differ between two runs with otherwise identical results, the result hashes shall be equal (oracle: metamorphic).
- AC-SPEC-11-06: When a person overrides core's proposed severity, the result shall keep both values and the override shall be an audit event (oracle: specified).
- AC-SPEC-11-07: When a run has both failed and needs-review items, or any other mix, the exit code shall be the first in `EXIT_PRECEDENCE` that applies (oracle: specified).

## Dependencies

- SPEC-08 to SPEC-10. The core skeleton's result and run modules (spike P3 `result.ts`, `run.ts`).
- Research background: API and integration (`05` Finding 3); maturity and roles (`10` Finding 3). JUnit and SARIF consumers [C-R07-025][C-R07-027].

## Milestone

M3.

## Satisfies

FR-12, FR-13
