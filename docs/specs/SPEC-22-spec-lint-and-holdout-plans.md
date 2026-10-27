# SPEC-22: Spec lint and holdout plans

## Purpose

Make specs strong enough to build from, and give Level 5 an independent verifier the building agent cannot touch. Independent means independent of the building agent, not a second person: the owner may approve holdout plans alone (founder, 2026-10-27). It serves "the agent says its tests pass, but it wrote the tests" (UP-04): the agent no longer marks its own homework.

## Scope and non-goals

- **In:** a spec lint (Gherkin, EARS, Spec Kit and OpenSpec inputs) requiring acceptance-criterion ids, edge cases and a risk class before build (criteria agreed before build, RC-10; depth sized to risk, RC-05); a holdout store outside the repository; holdouts read only by a workflow definition taken from the protected branch (for example a required workflow set by a repository ruleset), never by one the change under test can add or edit; the read credential is available only to that workflow and never to jobs defined in the change; holdout plans carry a person's approval (SPEC-02), the owner's declared approval under agent lock-down or an optional verified one, given by listing the plan's hash in protected-branch `holdouts.json`, and are reused across changes; levels and metrics resting on declared holdouts are labelled `declared` (SPEC-21); `unreviewedMergeShare` counts only merges gated by holdout plans; `planApprovalsPerChange` is measured from approvals.
- **Non-goals:** generating specs; LLM judgement of spec quality as a gate.

## Interfaces and types

```ts
export type SpecLintIssue = { specReference: string; code: 'missing-criterion-id' | 'no-edge-case' | 'no-risk-class' | 'criterion-not-testable'; line: number };
export function lintSpec(text: string, format: 'gherkin' | 'ears' | 'spec-kit' | 'openspec'): readonly SpecLintIssue[];
export type HoldoutCaller = { workflowPath: string; workflowCommit: string; protectedRef: string; runId: string };
export interface HoldoutStore {            // outside the repository; read only from a protected workflow definition
  list(changeClassId: string): Promise<readonly Approval[]>;                     // verified or declared
  read(planHash: string, caller: HoldoutCaller): Promise<Result<Plan, 'forbidden' | 'not-found'>>;
  write(plan: Plan, approval: Approval): Promise<Result<void, 'forbidden'>>;   // a person's approval, verified or declared; never an agent's
}
```

## Acceptance criteria

- AC-SPEC-22-01: When a spec lacks an acceptance-criterion id, an edge case or a risk class, the lint shall report the matching code and line (oracle: specified).
- AC-SPEC-22-02: When an agent identity, or a person without a verified or declared approval (SPEC-02), tries to write a holdout plan, or any caller tries to read one, the store shall refuse it unless the caller is the protected-branch workflow, and log a `holdout.access-refused` event (oracle: specified).
- AC-SPEC-22-03: When a merge is counted in `unreviewedMergeShare`, it shall have a passing run of at least one approved holdout plan for its class (oracle: specified).
- AC-SPEC-22-04: When the lint runs twice on the same spec, the issues shall be identical (oracle: metamorphic).
- AC-SPEC-22-05: When a pull request adds or edits a workflow file, no job defined in that pull request shall obtain the holdout read credential or holdout content, and the attempt shall be logged (oracle: specified; red-team fixture repository).
- AC-SPEC-22-06: When a holdout run reports its result to the change, it shall report pass or fail per acceptance-criterion id and never the plan's steps or assertions (oracle: specified).
- AC-SPEC-22-07: When the maintainer writes a holdout plan whose hash reaches protected-branch `holdouts.json` by their own merge under agent lock-down, with no second account involved, the store shall accept it, and merges it gates shall count toward `unreviewedMergeShare` labelled `declared` (oracle: specified; solo fixture repository).
- AC-SPEC-22-08: When a holdout plan's hash is not listed in protected-branch `holdouts.json`, or the write's approval subject is not that hash, the store shall refuse the write with `forbidden` and log `holdout.access-refused` (oracle: specified).

## Dependencies

- SPEC-02, SPEC-21; the VCS ruleset or required-workflow feature of the customer's VCS (GitHub first).
- Research background: maturity and roles (`10` Findings 1 and 2). Same-agent tests show consistency, not correctness [C-R15-013].

## Milestone

Phase 2a (lint); phase 2b (holdout store).

## Satisfies

FR-31, FR-34
