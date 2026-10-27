# SPEC-27: Shared types, error codes and event sink

## Purpose

Give every other spec one set of core types, closed error-code unions and a minimal append-only event sink. Each stub can then be built without reading spike source, and M1 specs can emit audit events before the hash-chained audit log (SPEC-14) exists at M3. It serves "the agent says its tests pass, but it wrote the tests" (UP-04) and "letting AI agents into our pipeline feels like handing over the keys" (UP-09) indirectly: the actor on every event is derived by core, never declared by the caller.

## Scope and non-goals

- **In:**
  - `Brand` and `Result`;
  - the URL, locator, assertion, geometry and artefact types the plan, result and report specs share;
  - the driver port interfaces and `Session`, their composition;
  - `TargetId`, `Locale`, `FixtureReference` and `DialogInfo`;
  - `ActorId`, `ActorType` and `AuditEventKind`;
  - a minimal JSON Lines `EventSink` (append-only, no chain) that the audit log later wraps with hashing and an anchor;
  - every error-code union, each with a docs anchor;
  - `GuaranteeLevel`;
  - the ladder `Thresholds` shape.
- **Non-goals:** hash chaining and anchoring (SPEC-14); approval verification (SPEC-02); behaviour of any port (adapter specs).

## Interfaces and types

```ts
// Primitives
export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };  // built only by the owning module's parser
export type Result<Value, Failure> = { ok: true; value: Value } | { ok: false; error: Failure };
export type Origin = Brand<string, 'Origin'>;                                // scheme://host[:port], no path
export type AllowedUrl = Brand<string, 'AllowedUrl'>;                        // absolute URL whose origin is in the trusted allow-list
export type Role = 'button' | 'link' | 'textbox' | 'checkbox' | 'radio' | 'combobox' | 'listbox' | 'option' | 'tab'
  | 'menuitem' | 'heading' | 'dialog' | 'img' | 'table' | 'row' | 'cell' | 'navigation' | 'main' | 'form' | 'region';
export type ElementAssertion =
  | { kind: 'visible' | 'hidden' | 'absent' | 'enabled' | 'disabled' | 'checked' | 'unchecked' | 'focused' }
  | { kind: 'text' | 'value'; equals?: string; contains?: string }               // exactly one of equals/contains, non-empty
  | { kind: 'count'; equals: number };
export type PageAssertion = { kind: 'url'; equals: AllowedUrl } | { kind: 'title'; equals: string };
export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; // CSS px, page coordinates
export type ArtifactReference = { readonly path: string; readonly sha256: string;
  readonly mediaType: 'image/png' | 'image/svg+xml' | 'application/json' | 'text/html' };
export type GuaranteeLevel = 'isolated' | 'host';                            // host: no egress enforcement, no replay claim
export type TargetId = Brand<string, 'TargetId'>;                            // a target's id in the project's matrix
export type Locale = Brand<string, 'Locale'>;                                // BCP 47 language tag, e.g. "fr"
export type FixtureReference = { readonly name: FixtureName; readonly path: string; readonly sha256: string };

// Driver ports, implemented by each browser and device adapter.
export interface PageNavigator { goto(url: AllowedUrl): Promise<Result<void, DriverError>> }
// Locator and ActionStep are plan types declared with the plan language in the same core package; see SPEC-01.
export interface ActionRunner { act(step: ActionStep, locator: Locator): Promise<Result<void, DriverError>> }
export interface Prober {
  resolve(locator: Locator): Promise<Result<ResolvedElement, DriverError>>;
  check(locator: Locator, assertion: ElementAssertion): Promise<Result<boolean, DriverError>>;
}
// Returns the masked capture only, so personal data never reaches an image; see SPEC-09.
export interface Camera { capture(region: Box | null): Promise<Result<ArtifactReference, DriverError>> }
export type DialogInfo = { readonly kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; readonly text: string };
// One open browser or device session: every driver port together. Auditor is the accessibility port; see SPEC-10.
export interface Session extends PageNavigator, ActionRunner, Prober, Camera, Auditor {
  frame(locator: Locator): Promise<Result<Session, DriverError>>;      // scoped to an iframe
  onDialog(action: 'accept' | 'dismiss'): Promise<Result<DialogInfo, DriverError>>;
  upload(locator: Locator, file: FixtureReference): Promise<Result<void, DriverError>>;
  close(): Promise<void>;                                              // every started process exits
}
// The page element a locator resolved to, as the policy gate sees it before an action.
export type ResolvedElement = { role: Role | null; name: string | null; box: Box | null; formSubmitName: string | null; linkUrl: string | null };

// Actors and events
export type ActorId = Brand<string, 'ActorId'>;                              // keyed hash (HMAC) of the identity under the customer's key
// Set by core from the approval proof, never by the caller. person-declared: the agent lock-down route.
export type ActorType = 'person-verified' | 'person-declared' | 'agent' | 'ci' | 'unverified';
// Both person types gate and count alike; the label differs. Nothing requires a second person (founder, 2026-10-27).
export const PERSON_ACTOR_TYPES: readonly ActorType[] = ['person-verified', 'person-declared'];
export type AuditEventKind = 'plan.submitted' | 'plan.rejected' | 'plan.denied' | 'plan.approved' | 'approval.refused'
  | 'trusted.changed-with-code' | 'run.finished' | 'review.decided' | 'severity.overridden' | 'adapter.admitted'
  | 'pack.admitted' | 'check.removed' | 'tracker.changed' | 'holdout.access-refused';
// planProvenance (PlanProvenance, SPEC-28) is set on plan.submitted and plan.rejected: which authoring route produced the draft.
export type EventInput = { kind: AuditEventKind; subjectHash?: string; runId?: string; criterionIds?: readonly string[];
  planProvenance?: PlanProvenance };
export interface EventSink { append(event: EventInput, actor: DerivedActor): Result<{ sequence: number }, SinkError> }
// Only the approval verifier and core's runtime mint this, so a caller can't choose its own actor type.
export type DerivedActor = Brand<{ actor: ActorId; actorType: ActorType }, 'DerivedActor'>;

// Run history, read by the review recorder, the metrics panel and the ladder.
export type RunRecord = { runId: string; changeClassId: string; commit: string | null; at: string;
  criteriaInScope: number; criteriaTraced: number; passedFirstTime: boolean; flakyPair: boolean;
  decisions: readonly { itemId: string; actorType: ActorType }[] };
export type ThresholdMetric = 'agentAuthoredShare' | 'specLinkedShare' | 'tracedCriteriaShare' | 'mutantsCaughtShare'
  | 'verifiedWithoutReviewShare' | 'unreviewedMergeShare' | 'flakyRunRate';
export type Thresholds = Readonly<Record<ThresholdMetric, number>> & { windows: number; minimumChangesPerWindow: number };

// Closed error-code unions; each code has a docs anchor `errors#<code>`
export type PlanErrorCode = 'not-object' | 'unknown-key' | 'unknown-step' | 'bad-value' | 'missing-field' | 'vacuous'
  | 'no-criterion-id' | 'literal-secret' | 'pack-not-enabled' | 'version-unsupported' | 'too-large';
export type DriverErrorCode = 'not-found' | 'ambiguous' | 'not-actionable' | 'timeout' | 'navigation-failed' | 'target-crashed' | 'unsupported-step' | 'policy-denied';
export type DriverError = { code: DriverErrorCode; stepIndex: number };
export type RunnerError = { code: 'image-missing' | 'image-digest-mismatch' | 'egress-unenforceable' | 'start-failed' };
export type RecorderError = { code: 'no-reason' | 'unknown-item' | 'already-decided' | 'sink-failed' };
export type SinkError = { code: 'not-append-only' | 'write-failed' };
export type CliErrorCode = 'usage' | 'config-invalid' | 'untrusted-source' | 'plan-rejected' | 'target-unavailable'
  | 'lock-download-failed' | 'lock-offline' | 'approval-refused' | 'replay-mismatch' | 'internal';
```

## Acceptance criteria

- AC-SPEC-27-01: When a `switch` over any error-code union above omits a code, `tsc` shall fail through an exhaustiveness check (oracle: specified).
- AC-SPEC-27-02: When any spec's public signature is compiled, every type it names shall resolve to a declaration in core or in that spec's package (oracle: specified; `tsc` over the spec type files).
- AC-SPEC-27-03: When an event is appended, the sink shall write one JSON Lines entry and never modify an earlier line. An attempt to truncate or rewrite the file shall return `not-append-only` (oracle: specified).
- AC-SPEC-27-04: When code outside the approval verifier (SPEC-02) or core's runtime tries to build a `DerivedActor`, lint shall fail, so a caller can't declare its own actor type (oracle: specified).
- AC-SPEC-27-05: When a value of a branded type is created by a cast outside its owning module, lint shall fail (oracle: specified; generalises AC-SPEC-01-06).
- AC-SPEC-27-06: When the docs are built, every error code shall have an anchor, and a missing anchor shall fail the build (oracle: specified).
- AC-SPEC-27-07: When an `ElementAssertion` of kind `text` or `value` has neither or both of `equals` and `contains`, or an empty string, the parser shall reject it as `vacuous` (oracle: specified).
- AC-SPEC-27-08: When any gate, metric or level decides whether an actor is a person, it shall test membership of `PERSON_ACTOR_TYPES`, accepting `person-declared` exactly as `person-verified`; `agent`, `ci` and `unverified` shall never count. Lint shall fail a gating comparison against `'person-verified'` alone (oracle: specified).

## Dependencies

- SPEC-00 (repo and projects).
- The core skeleton's brand, plan and logging modules (spike P3 `brand.ts`, `plan.ts` and `logging.ts`), copied with source hashes.
- The audit log (SPEC-14) wraps the sink with a hash chain at M3; the approval verifier (SPEC-02) mints `DerivedActor`.

## Milestone

M0 (types) and M1 (sink).

## Satisfies

FR-01, FR-18, NFR-07
