# SPEC-27: Shared types, error codes and event sink

## Purpose

Give every other spec one set of core types, closed error-code unions and a minimal append-only event sink. Each stub can then be built without reading spike source, and M1 specs can emit audit events before the hash-chained audit log (SPEC-14) exists at M3. It serves "the agent says its tests pass, but it wrote the tests" (UP-04) and "letting AI agents into our pipeline feels like handing over the keys" (UP-09) indirectly: the actor on every event is derived by core, never declared by the caller.

## Scope and non-goals

- **In:**
  - `Brand` and `Result`;
  - the URL, safe-text, assertion, geometry, probe and artefact types the plan, result and report specs share;
  - the driver port interfaces and `Session`, their composition;
  - `TargetId`, `Locale`, `FixtureReference` and `DialogInfo`;
  - `ActorId`, `ActorType` and `AuditEventKind`;
  - a minimal JSON Lines `EventSink` (append-only, no chain) that the audit log later wraps with hashing and an anchor;
  - every error-code union, each with a docs anchor;
  - `GuaranteeLevel`;
  - the ladder `Thresholds` shape.
- **Non-goals:** hash chaining and anchoring (SPEC-14); approval verification (SPEC-02); behaviour of any port (adapter specs).

## Interfaces and types

The primitive, assertion, artefact, driver-port and plan- and driver-error shapes follow the seeded code and the frozen tests, except where marked "addition" (see the note after the block). Actors, events, run history, thresholds and the error unions with no code yet are new with this spec.

```ts
// Primitives
export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };  // built only by the owning module's parser
export type Success<Value> = { readonly ok: true; readonly value: Value };
export type Failure<Problem> = { readonly ok: false; readonly error: Problem };
export type Result<Value, Problem> = Success<Value> | Failure<Problem>;
export const success = <Value>(value: Value): Success<Value> => ({ ok: true, value });
export const failure = <Problem>(error: Problem): Failure<Problem> => ({ ok: false, error });
export type Origin = Brand<string, 'Origin'>;                                // scheme://host[:port], no path
export type AllowedUrl = Brand<string, 'AllowedUrl'>;                        // a URL path, or an absolute URL whose origin is on the allow-list
// Text that passed the parser's safety rules: no control or bidirectional-override characters, nothing script-like.
export type SafeText = Brand<string, 'SafeText'>;
export const ROLES = [
  'alert', 'button', 'checkbox', 'combobox', 'dialog', 'heading', 'img', 'link', 'listitem', 'main', 'navigation',
  'option', 'radio', 'region', 'searchbox', 'status', 'switch', 'tab', 'textbox',
  'listbox', 'menuitem', 'table', 'row', 'cell', 'form',                    // addition
] as const;
export type Role = (typeof ROLES)[number];
// What "passed" means is decided by the engine's oracle, never by a driver or an AI.
// The kind names the check; `value` is what it compares against.
export type ElementAssertion =
  | { readonly kind: 'visible' | 'hidden' | 'enabled' | 'disabled' }
  | { readonly kind: 'textEquals' | 'textContains' | 'valueEquals'; readonly value: SafeText }
  | { readonly kind: 'absent' | 'checked' | 'unchecked' | 'focused' }                              // addition
  | { readonly kind: 'valueContains'; readonly value: SafeText }                                   // addition
  | { readonly kind: 'countEquals'; readonly value: number };                                      // addition
export type PageAssertion =
  | { readonly kind: 'urlPath' | 'title'; readonly value: SafeText }
  | { readonly kind: 'url'; readonly value: AllowedUrl };                                          // addition: the whole absolute URL
export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; // CSS px, page coordinates
// A stored artefact. mediaType is open: screenshots are image/png, release notes text/markdown.
export type ArtifactReference = { readonly name: string; readonly mediaType: string; readonly sha256: string; readonly bytes: number };
export type GuaranteeLevel = 'isolated' | 'host';                            // host: no egress enforcement, no replay claim
export type TargetId = Brand<string, 'TargetId'>;                            // a target's id in the project's matrix
export type Locale = Brand<string, 'Locale'>;                                // BCP 47 language tag in canonical form, e.g. "de-DE"
// A fixture file the run served, pinned by hash in the manifest. Declared in engine, beside the manifest.
export type FixtureReference = { readonly path: string; readonly sha256: string };

// Driver ports, implemented by each browser and device adapter.
// Locator and ActionStep are plan types declared with the plan language in contracts; see SPEC-01.
export interface PageNavigator {
  // An absolute URL: the engine resolves the plan's AllowedUrl against the base URL first. The session itself
  // refuses origins off the allow-list and reports them in blockedOrigins().
  navigate(url: string): Promise<Result<void, DriverError>>;
  page(): Promise<PageProbe>;
}
export type PageProbe = { readonly url: string; readonly title: string };
export interface ActionRunner { act(step: ActionStep): Promise<Result<void, DriverError>> }       // the step carries its locator
// A read-only look at what a locator matches. A count other than 1 means not found or ambiguous.
// The engine's oracle turns the probe into a verdict, so a driver never decides pass or fail.
export interface Prober { probe(locator: Locator): Promise<ElementProbe> }
export type ElementProbe = {
  readonly count: number; readonly visible: boolean; readonly enabled: boolean;
  readonly text: string; readonly value: string | null;
  readonly sensitive: boolean;                       // the element, an ancestor or a descendant matches a personal-data selector
  readonly box: Box | null;
};
// PNG bytes of the viewport, with every element matching `mask` painted solid black. The run always passes the
// redactor's selectors, so personal data never reaches a stored image; the masking proof also takes an unmasked
// shot to compare. The engine stores the bytes through the artefact store. See SPEC-09.
export interface Camera { screenshot(mask: readonly string[]): Promise<Uint8Array> }
// The session's accessibility port. The audit engines that build on it are in SPEC-10.
export interface Auditor {
  audit(): Promise<readonly A11yFinding[]>;
  accessibilitySnapshot(): Promise<A11yNode>;
}
export type Impact = 'minor' | 'moderate' | 'serious' | 'critical' | 'unknown';
export type A11yFinding = { readonly ruleId: string; readonly impact: Impact; readonly elementCount: number }; // one failed rule
export type A11yNode = { readonly role: string; readonly name: string; readonly children: readonly A11yNode[] };
export type DialogInfo = { readonly kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; readonly text: string }; // addition
// One open browser or device session: every driver port together.
export interface Session extends PageNavigator, ActionRunner, Prober, Camera, Auditor {
  readonly browser: { readonly name: string; readonly version: string };
  blockedOrigins(): readonly string[];                                 // origins refused, as evidence the run stayed hermetic
  close(): Promise<void>;                                              // every started process exits
  frame(locator: Locator): Promise<Result<Session, DriverError>>;      // addition: scoped to an iframe
  onDialog(action: 'accept' | 'dismiss'): Promise<Result<DialogInfo, DriverError>>;      // addition
  upload(locator: Locator, file: FixtureReference): Promise<Result<void, DriverError>>;  // addition
}
// Addition: the page element a locator resolved to, as the policy gate sees it before an action. The driver builds
// it inside act() and passes it to guardAction (SPEC-03, SPEC-06); it is not a Session method.
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
// The audit sink. The run's step log (RunEventSink in engine, written through the logging manifest) is separate.
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

// Closed error-code unions; each code has a docs anchor `errors#<code>`.
// Plan errors are declared in engine beside the parser, as PLAN_ERROR_CODES; PlanError is { code, path } (SPEC-01).
export type PlanErrorCode = 'not_object' | 'unknown_field' | 'missing_field' | 'wrong_type' | 'unknown_step'
  | 'unknown_value' | 'invalid_url' | 'scheme_not_allowed' | 'origin_not_allowed' | 'target_not_in_matrix'
  | 'unsafe_text' | 'too_large' | 'too_long' | 'duplicate' | 'version_unsupported' | 'empty'
  | 'vacuous' | 'no_criterion_id' | 'literal_secret' | 'pack_not_enabled';                         // addition
export type DriverErrorCode = 'not-found' | 'ambiguous' | 'not-actionable' | 'timeout' | 'navigation-failed'
  | 'target-crashed' | 'unsupported-step' | 'policy-denied';                                       // addition
// A driver doesn't know the step's index; the run records the code against the step. detail is a short
// diagnostic for whoever debugs the driver; the run keeps only the code.
export type DriverError = { readonly code: DriverErrorCode; readonly detail: string };
export type RunnerError = { code: 'image-missing' | 'image-digest-mismatch' | 'egress-unenforceable' | 'start-failed' };
export type RecorderError = { code: 'no-reason' | 'unknown-item' | 'already-decided' | 'sink-failed' };
export type SinkError = { code: 'not-append-only' | 'write-failed' };
export type CliErrorCode = 'usage' | 'config-invalid' | 'untrusted-source' | 'plan-rejected' | 'target-unavailable'
  | 'lock-download-failed' | 'lock-offline' | 'approval-refused' | 'replay-mismatch' | 'internal';
```

**Additions.** The seeded code lacks the shapes marked "addition", and later specs need them. Each is added with the spec that first uses it, on top of the seeded shapes, never by changing one:

- `Role` values `listbox`, `menuitem`, `table`, `row`, `cell` and `form`; assertion kinds `absent`, `checked`, `unchecked`, `focused`, `valueContains` and `countEquals`, and page kind `url` (plan v1.1 and the readable grammar: SPEC-01, SPEC-28);
- plan codes `vacuous` and `no_criterion_id` (SPEC-01), `literal_secret` (SPEC-04) and `pack_not_enabled` (SPEC-23);
- driver codes `target-crashed`, `unsupported-step` and `policy-denied`, and `ResolvedElement` (SPEC-03, SPEC-06);
- `Session.frame`, `onDialog` and `upload`, and `DialogInfo` (SPEC-01 v1.1 steps, SPEC-06). `FixtureReference` moves from engine to contracts when `upload` is added, because drivers import only contracts.

## Acceptance criteria

- AC-SPEC-27-01: When a `switch` over any error-code union above omits a code, `tsc` shall fail through an exhaustiveness check (oracle: specified).
- AC-SPEC-27-02: When any spec's public signature is compiled, every type it names shall resolve to a declaration in core or in that spec's package (oracle: specified; `tsc` over the spec type files).
- AC-SPEC-27-03: When an event is appended, the sink shall write one JSON Lines entry and never modify an earlier line. An attempt to truncate or rewrite the file shall return `not-append-only` (oracle: specified).
- AC-SPEC-27-04: When code outside the approval verifier (SPEC-02) or core's runtime tries to build a `DerivedActor`, lint shall fail, so a caller can't declare its own actor type (oracle: specified).
- AC-SPEC-27-05: When a value of a branded type is created by a cast outside its owning module, lint shall fail (oracle: specified; generalises AC-SPEC-01-06).
- AC-SPEC-27-06: When the docs are built, every error code shall have an anchor, and a missing anchor shall fail the build (oracle: specified).
- AC-SPEC-27-07: When an `ElementAssertion` whose kind takes a text `value` (`textEquals`, `textContains`, `valueEquals`, `valueContains`) has no `value`, the parser shall reject it as `missing_field`; when the `value` is an empty string, it shall reject it as `vacuous` (oracle: specified).
- AC-SPEC-27-08: When any gate, metric or level decides whether an actor is a person, it shall test membership of `PERSON_ACTOR_TYPES`, accepting `person-declared` exactly as `person-verified`; `agent`, `ci` and `unverified` shall never count. Lint shall fail a gating comparison against `'person-verified'` alone (oracle: specified).

## Dependencies

- SPEC-00 (repo and projects).
- The core skeleton's brand, plan and logging modules (spike P3 `brand.ts`, `plan.ts` and `logging.ts`), copied with source hashes.
- The audit log (SPEC-14) wraps the sink with a hash chain at M3; the approval verifier (SPEC-02) mints `DerivedActor`.
- Founder decision, 2026-10-28: the shared types follow the shapes the seeded tests use.
- Founder decision, 2026-10-28: each error-code union keeps one spelling. The seeded plan and report codes use underscores (`unknown_step`); every other union uses hyphens (`not-found`).

## Milestone

M0 (types) and M1 (sink).

## Satisfies

FR-01, FR-18, NFR-07
