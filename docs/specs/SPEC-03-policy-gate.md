# SPEC-03: Policy gate: origin allow-list and action deny-list

## Purpose

Containment stops invalid plans, not harmful valid ones. An origin allow-list and an action deny-list, checked before execution and again before each action, narrow what a valid plan can do. It serves "letting AI agents into our pipeline feels like handing over the keys" (UP-09): an agent's plan can't press "Delete account" or touch production. It is a mitigation, not a bound: the bound is non-production origins with disposable data (research architecture doc, `04` Finding 3).

## Scope and non-goals

- **In:**
  - typestate `Planned -> Authorised | Denied`;
  - a static check: undeclared origins, production origins, plans over limits, and actions whose locator name matches an irreversible pattern;
  - a runtime guard called by the driver before every action with the resolved element: irreversible `click`; `press` of Enter or Space, or `submit`, in a form whose submit control matches; `navigate` to a URL matching a declared destructive pattern; `dialog accept` whose dialog text matches; any action on a control with no accessible name, unless the project allows it by test id;
  - irreversible patterns (delete, pay, send, revoke and project additions) declared per locale in the trusted project; a target locale with no pattern set is denied;
  - deny decisions as typed results, and as audit events through the shared event sink (SPEC-27) from M1.
- **Non-goals:** Cedar or another policy language (later); semantic judgement of whether a plan matches its spec; rules about people (the no-scoring rule is a build-time rule in SPEC-14, NFR-06).

## Interfaces and types

```ts
export type PolicyRuleId =
  | 'irreversible-action' | 'irreversible-submit' | 'destructive-navigation' | 'irreversible-dialog'
  | 'unnamed-control' | 'no-locale-patterns' | 'undeclared-origin' | 'production-origin' | 'over-limit';
export type PolicyDecision =
  | { kind: 'allow'; plan: Authorised }
  | { kind: 'deny'; rule: PolicyRuleId; stepIndex: number | null };
export type Authorised = Brand<Plan, 'Authorised'>;
export type IrreversiblePatterns = Readonly<Record<Locale, readonly string[]>>;   // case-insensitive whole-word, from the trusted project
export interface PolicyGate {
  decide(plan: Plan, project: TrustedProject, targets: readonly Target[]): PolicyDecision;               // pure, no I/O
  guardAction(step: Step, stepIndex: number, element: ResolvedElement, dialogText: string | null, locale: Locale):
    { kind: 'allow' } | { kind: 'deny'; rule: PolicyRuleId; stepIndex: number };                        // pure, no I/O
}
```

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; the first three are the founder's decisions, the rest are in `docs/decisions/answers.md`):

- **Testing a delete feature.** The project allows irreversible actions in the trusted `policy.allowedIrreversibleNames`: exact accessible names, case-insensitive, such as "Delete account". A person approves that list like any trusted file. An allowed name passes `irreversible-action`, `irreversible-submit` and `irreversible-dialog`. Runs stay automatic; the gate is a check inside every run.
- **Production.** Denied by default for every plan. When the trusted `policy.allowProductionForApprovedPlans` is `true`, an approved plan may use production origins (SPEC-02's `planStanding`). A proposal never may.
- **Test helpers.** Shared test helpers clear each plan through the gate before `run()`, in a tests commit of their own. SPEC-02's production test gains the explicit allowance (founder, 2026-10-28).
- **Building the gate.** `policyGate({ project, events })` returns the `PolicyGate`. `decide(plan, targets, standing)` takes the plan's standing; a missing standing means a proposal. `guardAction` reads its patterns and allowances from the same project. Each denial appends one `plan.denied` event whose `code` is the rule.
- **`Authorised`.** It is branded with its own key, so it stays a narrower `Plan` and doesn't collapse to `never` with SPEC-27's `Brand`.
- **Patterns.** Engine ships base sets for `en`, `de` and `fr` (delete, pay, send and revoke, and their equivalents); the project adds to them per locale. A locale like `fr-FR` falls back to `fr`. A locale with neither a base set nor a project set is denied with `no-locale-patterns`.
- **Destructive URLs.** A pattern is a URL path. It matches the same path, or one that continues it after a `/`. A click on a link whose resolved URL matches is `destructive-navigation`.
- **Step index.** The first offending step, or `null` for `no-locale-patterns` and `over-limit`.
- **Scope of each check.** The static check reads `navigate` and the locator names of clicks. Presses, submits and dialogs need the page, so the runtime guard checks them. `unnamed-control` doesn't apply to dialog steps. A runtime denial ends the run `Denied`, with no input event for that step.
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
