# SPEC-19: Firefox driver and Playwright plug-in

## Purpose

Widen reach without weakening guarantees. It serves "we can't honestly say whether it works on Safari or a phone" (UP-07) with stock Firefox, named, and "manual regression holds the release up" (UP-05): teams with existing Playwright suites can add core checks without a rewrite.

## Scope and non-goals

- **In:** the own-driver spike's WebDriver BiDi client (P4) driving stock Firefox with the same capabilities and egress controls as SPEC-06; popups, downloads and multiple pages on CDP and BiDi; an optional Playwright plug-in (`core.check(page, plan)`) that runs parsed plans inside a customer's suite, labelled guarantee level `host`.
- **Non-goals:** Playwright's patched WebKit as "Safari"; network isolation in `host` mode.

## Interfaces and types

```ts
// GuaranteeLevel ('isolated' | 'host') is a shared core type; 'host' means no egress enforcement and no replay claim.
export interface PlaywrightPlugin {
  check(page: unknown /* Playwright Page, typed in the adapter package */, plan: unknown): Promise<RunResult & { guaranteeLevel: 'host' }>;
}
```

## Acceptance criteria

- AC-SPEC-19-01: When the core skeleton's contract suite (spike P3) and the CDP driver's capability suite (SPEC-06) run on stock Firefox over BiDi in the Linux image, all tests shall pass (oracle: regression; extends AC-p4-04).
- AC-SPEC-19-02: When a Firefox page opens a WebSocket, worker or popup to an undeclared origin, the egress proxy shall block it (oracle: specified).
- AC-SPEC-19-03: When a plan uses a popup, download or second page on CDP or BiDi, the step shall run and its evidence shall name the page (oracle: specified).
- AC-SPEC-19-04: When the Playwright plug-in runs a plan, the result shall carry `guaranteeLevel: 'host'` and the report shall make no replay or egress claim (oracle: specified).
- AC-SPEC-19-05: When the default runtime set is built, it shall not include the plug-in package (oracle: specified).

## Dependencies

- SPEC-06, SPEC-07. The own-driver spike's BiDi client (P4).
- Research background: API and integration (`05` Finding 4); independence and breadth (`12` Finding 2).

## Milestone

Phase 2a; Firefox first after beta, the plug-in on partner demand.

## Satisfies

FR-26, FR-27
