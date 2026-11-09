# SPEC-03: Policy gate: origin allow-list and action deny-list

## Purpose

Containment stops invalid plans, not harmful valid ones. An origin allow-list and an action deny-list, checked before execution and again before each action, narrow what a valid plan can do. It serves "letting AI agents into our pipeline feels like handing over the keys" (UP-09): an agent's plan can't press "Delete account" or touch production. It is a mitigation, not a bound: the bound is non-production origins with disposable data (research architecture doc, `04` Finding 3).

## Scope and non-goals

- **In:**
  - typestate: the gate turns a parsed plan into a `ClearedRun` (plan, project, target and standing held together) or a denial, and `run()` takes only a `ClearedRun`;
  - a static check: undeclared origins, production origins, plans over limits, and actions whose locator name matches an irreversible pattern;
  - a runtime guard called by the driver before every action with the resolved element: irreversible `click`; `press` of Enter or Space, or `submit`, in a form whose submit control matches; `navigate` to a URL matching a declared destructive pattern; `dialog accept` whose dialog text matches; any action on a control with no accessible name, unless the project allows it by test id;
  - irreversible patterns (delete, pay, send, revoke and project additions) declared per locale in the trusted project; a target locale with no pattern set is denied;
  - deny decisions as typed results, and as audit events through the shared event sink (SPEC-27) from M1.
- **Non-goals:** Cedar or another policy language (later); semantic judgement of whether a plan matches its spec; rules about people (the no-scoring rule is a build-time rule in SPEC-14, NFR-06).

## Interfaces and types

```ts
// A constant object and a type of the same name in contracts. Later specs add the last four.
export type PolicyRuleId =
  | 'irreversible-action' | 'irreversible-submit' | 'destructive-navigation' | 'irreversible-dialog'
  | 'unnamed-control' | 'no-locale-patterns' | 'undeclared-origin' | 'production-origin' | 'over-limit'
  | 'side-effect-in-proposal' | 'inline-script-in-proposal' | 'unsafe-feature-disabled' | 'undeclared-secret';
export type PlanDenial = { kind: 'deny'; rule: PolicyRuleId; stepIndex: number | null; unrecorded?: true };
// One outcome per target id: a run the gate cleared, or a target the plan or the matrix doesn't declare, on which nothing runs.
export type TargetClearance = ClearedRun | TargetNotDeclared;
export type PlanClearance = { kind: 'allow'; runs: readonly TargetClearance[] } | PlanDenial;
export type RunClearance = { kind: 'allow'; run: ClearedRun } | TargetNotDeclared | PlanDenial;
// A class with a private field: only the gate makes one, and run() takes nothing else.
export class ClearedRun { readonly plan: Plan; readonly project: Project; readonly target: Target; readonly targetId: TargetId; readonly standing: PlanStanding }
export type IrreversiblePatterns = Readonly<Partial<Record<Locale, readonly string[]>>>;   // case-insensitive whole-word, from the trusted project
export interface PolicyGate {
  decide(plan: Plan, targetIds: readonly TargetId[], standing?: PlanStanding): PlanClearance;   // no I/O but a denial's audit event
  clear(plan: Plan, targetId: TargetId, standing?: PlanStanding): RunClearance;                 // decide() for one target
  guardAction(step: Step, stepIndex: number, element: ResolvedElement, dialogText: string | null, locale: Locale): GuardVerdict; // no I/O but a denial's audit event
}
```

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; the first three are the founder's decisions, the rest are in `docs/decisions/answers.md`):

- **Testing a delete feature.** The project allows irreversible actions in the trusted `policy.allowedIrreversibleNames`: exact accessible names, case-insensitive, such as "Delete account". A person approves that list like any trusted file. An allowed name passes `irreversible-action`, `irreversible-submit` and `irreversible-dialog`. Runs stay automatic; the gate is a check inside every run.
- **Production.** Denied by default for every plan. When the trusted `policy.allowProductionForApprovedPlans` is `true`, an approved plan may use production origins (SPEC-02's `planStanding`). A proposal never may.
- **Test helpers.** Shared test helpers clear each plan through the gate before `run()`, in a tests commit of their own. SPEC-02's production test gains the explicit allowance (founder, 2026-10-28).
- **Building the gate.** `policyGate({ project, events })` returns the `PolicyGate`. `decide(plan, targetIds, standing)` takes the plan's standing, and `clear(plan, targetId, standing)` is the same for one target. A missing standing, or one approved for another plan's hash, means a proposal. `guardAction` reads its patterns and allowances from the same project. Each denial appends one `plan.denied` event whose `code` is the rule.
- **`ClearedRun`.** It replaces the `Authorised` brand (`packages/engine/src/policy/ClearedRun.ts`). It is a class with a private field and the engine exports only its type, so an object written by hand, a copy or a spread never type-checks as one and fails `isCleared` at run time. Only the gate's output is one. `run()` calls `assertCleared` before any side effect, so an object the gate didn't make is refused whatever its type says.
- **A cleared run belongs to one project.** The gate clears a plan together with the project, target and standing it judged, in one frozen value. A run under another project, such as one whose `allowedIrreversibleNames` allowed the click, can't be expressed, so `run()` needs no project hash to compare.
- **Patterns.** Engine ships base sets for `en`, `de` and `fr` (delete, pay, send and revoke, and their equivalents); the project adds to them per locale. A locale like `fr-FR` falls back to `fr`. A locale with neither a base set nor a project set is denied with `no-locale-patterns`. A static check with no targets uses every set, so the engine's own always apply.
- **Matching.** Names and patterns are compared after NFKC folding (full-width letters), removing format characters (soft hyphen, zero-width joiner) and splitting camelCase ("DeleteAccount" reads "Delete Account"). Matches stay whole-word, so "DeletedItems" and "UndeleteItem" pass. A false positive such as "PayPal" matching "pay" is accepted: it errs on the safe side. Allowed names still compare exactly, ignoring case and spacing.
- **Destructive URLs.** A pattern is a URL path. It matches the same path, or one that continues it after a `/`. A click on a link whose resolved URL matches is `destructive-navigation`.
- **Step index.** The first offending step, or `null` for `no-locale-patterns` and `over-limit`.
- **Scope of each check.** The static check reads `navigate` and the locator names of clicks. Presses, submits and dialogs need the page, so the runtime guard checks them. `unnamed-control` doesn't apply to dialog steps. A runtime denial ends the run `Denied`, with no input event for that step.
- **Dialog steps.** `PerformableAction` includes the resolved dialog step, so `run()` hands a dialog step to `Session.act` like any action, and the driver asks the guard first. `ActionGuard` is `(element, dialogText)`: for a dialog the element's fields are all null and `dialogText` is the open dialog's text; otherwise it is null.
- **Unrecorded denials.** A denial whose `plan.denied` append fails carries `unrecorded: true` on the `PlanDenial`, the `GuardVerdict`, the `DeniedPlan` and the run's `denial`, so the outcome and the result hash differ from a recorded denial. `RunPorts.audit` is required, so no run can deny a plan without a sink to record it (founder, 2026-10-29).
- **For SPEC-06 and the M1 exit review.**
  - `Session.act(action, guard)` requires the guard, so a call without one doesn't compile. The driver calls it before every action, dialog steps included (passing the dialog's text).
  - Denial events carry actor type `unverified`, because the gate can't know who wrote the plan.
- **Anchors.** Each rule id gets a `## <rule>` heading in `docs/errors.md` and joins the error-anchor list.

## Acceptance criteria

- AC-SPEC-03-01: When a parsed plan clicks a control whose accessible name matches an irreversible pattern and the project does not allow it, the gate shall deny it with `irreversible-action` and the step index (oracle: specified).
- AC-SPEC-03-02: When a plan navigates to an origin marked production, the gate shall deny it with `production-origin` (oracle: specified).
- AC-SPEC-03-03: When the harmful but valid plans from the red-team set (at least one per action kind in this spec) are run, each shall end `Denied` with zero input events dispatched for the denied step (oracle: specified).
- AC-SPEC-03-04: When `run()` is called with a `Plan` that has not been authorised, it shall not type-check (oracle: specified; `@ts-expect-error` proof).
- AC-SPEC-03-05: When the gate denies a plan or an action, core shall append a `plan.denied` event through the M1 sink, and re-planning shall be a new proposal (oracle: specified).
- AC-SPEC-03-06: When the gate is called twice with the same inputs, it shall return the same decision (oracle: metamorphic).
- AC-SPEC-03-07: When a plan presses Enter in a text field of a form whose submit control is named "Delete account", the runtime guard shall deny it with `irreversible-submit` (oracle: specified).
- AC-SPEC-03-08: When a plan navigates to a URL matching a declared destructive pattern on an allowed origin, the gate shall deny it with `destructive-navigation` (oracle: specified).
- AC-SPEC-03-09: When a plan accepts a dialog whose text matches an irreversible pattern, the runtime guard shall deny it with `irreversible-dialog` (oracle: specified).
- AC-SPEC-03-10: When a plan acts on a control with no accessible name that the project has not allowed by test id, the runtime guard shall deny it with `unnamed-control` (oracle: specified).
- AC-SPEC-03-11: When a target's locale has a pattern set, a matching name in that language (for example "Supprimer" under `fr`) shall be denied; when it has none, the plan shall be denied with `no-locale-patterns` (oracle: specified).

## Dependencies

- SPEC-01, SPEC-02, SPEC-27. SPEC-06 calls `guardAction` before every action; SPEC-14 chains the events.
- Research background: architecture (`04` Findings 3 and 4). A valid plan from injected text can still act [C-R09-016].

## Milestone

M1 (static check and guard logic); wired into the driver at M2.

## Satisfies

FR-05

**Amendment (2026-11-09, architecture refactor).** `Authorised` is gone: the gate gives a `ClearedRun`, which holds the plan, project, target and standing, and `run()` takes nothing else. The types, the gate's signatures and the notes on the guard, dialog steps and unrecorded denials now match the code, and the Playwright driver is no longer mentioned, since it is removed. No criterion or guarantee changed: a plan the gate has not cleared still can't be run, by type or at run time.
