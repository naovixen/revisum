# SPEC-23: Protocol packs

## Purpose

Extend typed plans beyond the browser to APIs, identity and integration standards, keeping the same containment (typed plans beyond the browser, H18). It serves "integrations fail on expired tokens, retries or another tenant's data, and customers find it first" (UP-10): expired tokens, retries and cross-tenant reads are tested before customers find them.

## Scope and non-goals

- **In:** packs `http/v1` and `oidc/v1` (OpenID Connect) first, then `webhook/v1` and `lti/v1` (Learning Tools Interoperability) with tenant-isolation cases; one mutant of the system under test per negative family (wrong audience, bad signature, `alg: none`, skipped webhook signature, non-idempotent retry, cross-tenant leak); a read-only check of the real issuer's discovery document and audience; packs loaded only from trusted project config and admitted when their suite passes; live counterparts and preview releases in a separate, non-gating lane; identity and integration-standard results (RC-18) reported as "system under test verified" and "core client safety".
- **Non-goals:** SAML 2.0 (not built until an XML library passes the dependency review, R11); certification (bodies certify).

## Interfaces and types

```ts
export type PackId = `${string}/v${number}`;              // e.g. "oidc/v1"
export type FaultId = Brand<string, 'FaultId'>;          // namespaced, e.g. "oidc.expired-token"
// A pack step after parsing; its data is typed by the pack's own parser.
export type PackStep = Brand<{ type: `${string}.${string}/v${number}`; pack: PackId; data: unknown }, 'PackStep'>;
export type StepParser = { readonly stepType: PackStep['type']; parse(input: unknown, path: string): Result<PackStep, readonly PlanError[]> };
// A local stand-in service on a fixture origin: the mock, or a mutant that injects one defect.
export type MockService = { readonly origin: Origin; stop(): Promise<void> };
export type MockFactory = { start(seed: number): Promise<MockService> };
export type MutantFactory = { readonly id: string; readonly family: string; start(seed: number): Promise<MockService> };
export type ConformanceSuite = { readonly cases: readonly {
  readonly id: string; readonly kind: 'positive' | 'negative' | 'hostile' | 'mutant'; readonly group: CaseGroup;
  readonly plan: unknown; readonly expected: 'pass' | 'fail' | 'rejected' }[] };
export interface ProtocolPack {
  readonly id: PackId;
  readonly steps: readonly StepParser[];                  // e.g. oidc.login/v1
  readonly errorCodes: readonly string[];                 // namespaced
  readonly faults: readonly FaultId[];
  readonly mock: MockFactory; readonly mutants: readonly MutantFactory[];
  readonly suite: ConformanceSuite;                       // positive, negative, hostile, mutant
}
export type PackAdmission = { id: PackId; suiteHash: string; passed: boolean; admittedBy: ActorId };
export type CaseGroup = 'system-under-test-verified' | 'core-client-safety';
```

## Acceptance criteria

- AC-SPEC-23-01: When the API-step spike's 60 cases (P7) run through the packs, all shall pass with identical replay (oracle: regression; reuses AC-p7-04 to AC-p7-33).
- AC-SPEC-23-02: When each negative family runs against its system-under-test mutant, the plan shall fail and name the defect (oracle: specified; extends AC-p7-29).
- AC-SPEC-23-03: When a plan names a pack not enabled in the trusted project, the parser shall reject it (oracle: specified).
- AC-SPEC-23-04: When the build runs, core packages shall import no pack (oracle: specified).
- AC-SPEC-23-05: When a live-lane run fails, it shall not fail a merge gate and shall be labelled non-hermetic (oracle: specified).
- AC-SPEC-23-06: When identity and integration-standard results are reported, each case shall sit in exactly one `CaseGroup` (oracle: specified).

## Dependencies

- SPEC-01, SPEC-04, SPEC-07. The API-step spike (P7).
- Research background: independence and breadth (`12` Findings 4 and 5). Real cross-tenant incidents [C-R19-036].

## Milestone

Phase 2b, when a pilot needs API checks.

## Satisfies

FR-35, FR-36
