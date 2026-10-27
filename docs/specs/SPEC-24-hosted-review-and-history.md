# SPEC-24: Hosted review and history

## Purpose

The first paid module: run history, level trends and shared review for teams who need links beyond CI (module 1 in the research go-to-market plan, `07`). It serves "we can't prove what was tested, against which spec, or by whom" (UP-08) and "we can't tell whether AI work gets through with less human checking" (UP-11) over time.

## Scope and non-goals

- **In:** opt-in upload of redacted artefacts only from `ArtifactStore`; per-tenant storage isolation; history and trend views over `levelAt` and the metrics panel, per project and per change class only; shared review that writes decisions through the same typed recorder; a data processing agreement (DPA) template; retention jobs matching the logging manifest; microVM isolation for any hosted run; the paid chat drafter (SPEC-28 route f) for hosted tenants, returning drafts only, with its model egress in the logging manifest and the DPA.
- **Non-goals:** any view or metric grouped by person or team; any chat or hosted route that approves a plan, decides a review item or runs a plan gated; running browsers on core's servers by default.

## Interfaces and types

```ts
export interface ArtifactStore {
  put(artifact: ArtifactReference, bytes: Uint8Array, options: { redacted: true }): Promise<void>; // unredacted is a type error
  get(artifact: ArtifactReference, tenant: TenantId): Promise<Uint8Array | null>;
}
export type TenantId = Brand<string, 'TenantId'>;
export type RetentionRule = { output: string; days: number };   // generated from the logging manifest
```

## Acceptance criteria

- AC-SPEC-24-01: When tenant A's credentials request tenant B's artefact, run or decision, the service shall refuse it (oracle: specified; tenant-isolation cases as in SPEC-23).
- AC-SPEC-24-02: When an artefact without the redacted flag is uploaded, the call shall not type-check and the server shall reject it (oracle: specified).
- AC-SPEC-24-03: When a retention period ends, the artefact shall be deleted and an audit event written (oracle: specified).
- AC-SPEC-24-04: When a hosted review decision is made, it shall produce the same audit event as the CLI recorder (oracle: specified).
- AC-SPEC-24-05: When an upload declares `redacted: true`, the server shall still run the secret leak scan (SPEC-04) and the PII pass (SPEC-09) on it and reject any upload with a hit, logging the rejection (oracle: specified; seeded-PII and planted-secret uploads).
- AC-SPEC-24-06: When a hosted chat session produces a plan, it shall reach the tenant only as a `PlanDraft` with source `chat` through `admitDraft`; a chat session's attempt to approve or decide shall be refused and logged (oracle: specified).

## Dependencies

- SPEC-04, SPEC-09, SPEC-14, SPEC-21, SPEC-28.
- Founder decision of 2026-10-27: metrics stay per project and per change class, never per person.
- Research background: interface (`11` Finding 5); moat, modules and go-to-market (`07` Finding 6).

## Milestone

Phase 2b, when a design partner pays for history or review.

## Satisfies

FR-37, FR-48
