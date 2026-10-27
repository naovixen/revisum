# SPEC-14: Audit log and traceability

## Purpose

Show who did what through core, and trace each acceptance criterion to the shipped change (auditable and traceable, R13). It serves "the agent says its tests pass, but it wrote the tests" (UP-04) and "we can't prove what was tested, against which spec, or by whom" (UP-08): proof of what was tested, against which spec and by whom, that an agent can't rewrite.

## Scope and non-goals

- **In:**
  - the shared event sink (SPEC-27) wrapped with a hash chain;
  - an append-only, hash-chained JSON Lines event log: plan submitted, rejected, denied, approved and run; review decision; severity override; adapter or pack admitted; check removed;
  - pseudonymous actor ids under a customer-held key, read through `SecretStore` from the CI secret store or, locally, the OS keychain or an environment variable, never from the repository;
  - the actor type always derived by core (SPEC-02), never taken from the caller;
  - the chain head anchored outside the agent's write scope each run (CI artefact or protected reference);
  - trace links from spec and acceptance criterion through plan, run and evidence to commit; a commit is linked through its `Spec:` and `Criteria:` trailers, in the format SPEC-00 defines;
  - **people-data rules:** metrics are grouped per project and per change class only, never per person or team, with no per-person views or exports;
  - a build-time rule that no module scores, ranks or evaluates people (NFR-06, moved from the policy gate).
- **Non-goals:** actions outside core (not seen); deployment links (needs a continuous-delivery source, phase 2); keyless signing (later).

## Interfaces and types

```ts
// ActorId, ActorType, AuditEventKind, DerivedActor, EventInput and SinkError are shared core types; see SPEC-27.
// ActorId is a keyed hash (HMAC) of the identity under the customer's key.
export type AuditEvent = {
  readonly sequence: number; readonly previousHash: string; readonly hash: string;
  readonly kind: AuditEventKind;
  readonly actor: ActorId; readonly actorType: ActorType;          // from DerivedActor only
  readonly planHash?: string; readonly runId?: string; readonly criterionIds?: readonly CriterionId[];
};
// The shared sink with a hash chain. The caller passes a DerivedActor, so it cannot declare its own actor type.
export interface ChainedEventSink { append(event: EventInput, actor: DerivedActor): Result<AuditEvent, SinkError> }
export type ChainAnchor = { sequence: number; hash: string; location: 'ci-artifact' | 'protected-reference'; runId: string };
export function verifyChain(events: readonly AuditEvent[], anchor: ChainAnchor | null):
  { ok: true } | { ok: false; reason: 'tampered' | 'anchor-missing' | 'anchor-ahead'; firstBadSequence?: number };
export function genesis(runId: string): ChainAnchor;               // first run only: sequence 0, recorded as such
export type TraceRow = { specReference: string; criterionId: CriterionId; planHash: string; runId: string; evidence: readonly ArtifactReference[]; commit: string | null };
export type MetricGrouping = 'project' | 'change-class';           // never person, team or actor
```

## Acceptance criteria

- AC-SPEC-14-01: When any event in a stored history is edited, removed or reordered, `verifyChain` against the anchor shall fail and name the first bad event (oracle: specified).
- AC-SPEC-14-02: When an agent identity rewrites the whole chain consistently, verification against the anchor outside its write scope shall still fail (oracle: specified).
- AC-SPEC-14-03: When an event is written, its actor field shall be a pseudonym, and the raw identity shall appear in no file core writes (oracle: specified).
- AC-SPEC-14-04: When a result is built, every acceptance criterion in scope shall have a `TraceRow` with at least one step and one evidence item, or appear as untraced (oracle: specified; reuses AC-p6-14).
- AC-SPEC-14-05: When a manifest is written in CI, it shall carry the commit SHA under test (oracle: specified).
- AC-SPEC-14-06: When a metric would be grouped by person, team or actor, core shall refuse to output it, and `MetricGrouping` shall admit only project and change class (oracle: specified).
- AC-SPEC-14-07: When no anchor is found for a log that has events, `verifyChain` shall return `anchor-missing`, never `ok`. On a project's first run, core shall write a genesis anchor and mark the run as the chain's start (oracle: specified).
- AC-SPEC-14-08: When the pseudonym key is absent, core shall refuse to write identity-derived actor ids and record the event with `actorType: 'unverified'` and a fixed placeholder actor (oracle: specified).
- AC-SPEC-14-09: When a caller passes an actor type to the sink directly, the code shall not compile (oracle: specified; `@ts-expect-error` proof).
- AC-SPEC-14-10: When a module that scores, ranks or evaluates people is added to the build (seeded fixture module), the build rule shall fail (oracle: specified).

## Dependencies

- SPEC-02, SPEC-08, SPEC-27.
- The core skeleton's exact-field logger (spike P3 `logging.ts`, `Exact<>`).
- Founder decision of 2026-10-27: metrics stay per project and per change class, never per person.
- Research background: architecture (`04` Findings 1 and 8); maturity and roles (`10` Finding 7). Append-only stores aid audit [C-R13-041]; worker-monitoring law [C-RTM-006].

## Milestone

M3.

## Satisfies

FR-18, FR-19, NFR-06
