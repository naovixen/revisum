# SPEC-18: MCP server

## Purpose

Let customers' AI agents drive core through the Model Context Protocol, submitting plans rather than browser actions (AI-drivable, R9). It serves "AI writes features faster than we can check them" (UP-01) and "letting AI agents into our pipeline feels like handing over the keys" (UP-09): an agent verifies its own feature through an independent, gated path.

## Scope and non-goals

- **In:** tools `list_targets`, `validate_plan`, `run_plan`, `get_result`, `get_artifact`; every request through the plan parser (SPEC-01) and the policy gate (SPEC-03); plans accepted in JSON or the readable text form (SPEC-28), each through `admitDraft` with provenance `customer-llm`, basis `core-recorded` and the session id as reference; unapproved plans run only as proposals on non-production origins; the report as a read-only MCP Apps view; the pinned MCP revision recorded in the manifest; an `AGENTS.md` for the repo.
- **Non-goals:** click, type or navigate tools; any tool that edits plans, baselines, policy or the matrix.

## Interfaces and types

```ts
export type McpTool = 'list_targets' | 'validate_plan' | 'run_plan' | 'get_result' | 'get_artifact';
export type RunPlanInput = { plan: unknown; format?: 'json' | 'text'; targets?: readonly string[] };   // plan stays unknown until parsed; text is read first (SPEC-28)
export type RunPlanOutput = { runId: string; mode: 'gated' | 'proposal'; result?: RunResult; errors?: readonly PlanError[] };
```

## Acceptance criteria

- AC-SPEC-18-01: When any tool receives a plan, it shall pass through the parser and policy gate before any side effect; hostile plans shall be rejected with zero driver calls (oracle: specified).
- AC-SPEC-18-02: When the tool list is read, it shall contain only the five tools above (oracle: specified).
- AC-SPEC-18-03: When `run_plan` receives a plan with no approval, the run mode shall be `proposal` and the origins non-production (oracle: specified).
- AC-SPEC-18-04: When the Apps view issues a request, it shall go through the same parser and gate as any other call (oracle: specified).
- AC-SPEC-18-05: When a run is made through MCP, its manifest shall record the MCP revision, and every event from the session shall carry `actorType: 'agent'` (oracle: specified).
- AC-SPEC-18-06: When an MCP session tries to approve a plan or decide a review item by any route, nothing shall gate or count toward `verifiedWithoutReviewShare`, `planApprovalsPerChange` or `unreviewedMergeShare` (oracle: specified).
- AC-SPEC-18-07: When `validate_plan` or `run_plan` receives the readable form, the result shall equal that for the same plan in JSON, errors shall give line and column, and the `plan.submitted` event shall carry source `customer-llm` (oracle: specified).

## Dependencies

- SPEC-16 (CLI contract v1 frozen first); SPEC-01, SPEC-03, SPEC-12, SPEC-28.
- Research background: API and integration (`05` Finding 4); interface (`11` Finding 2). MCP's governance [C-R14-042].

## Milestone

Phase 2a, after CLI contract v1.

## Satisfies

FR-25, FR-45
