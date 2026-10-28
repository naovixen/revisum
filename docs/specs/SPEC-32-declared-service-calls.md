# SPEC-32: Declared service calls: test data, cleanup and backend checks

## Purpose

The study's largest gap is setup: 24 of the 62 inexpressible tests seed records through an API or the database first, and 3 more check backend state the UI does not show. Letting a plan send arbitrary requests would hand an agent the keys. This spec lets the project declare named HTTP calls in the trusted project file, which a person approves (SPEC-02). A plan may only invoke a call by name, with arguments typed by the declaration. It serves "letting AI agents into our pipeline feels like handing over the keys" (UP-09) and "AI writes features faster than we can check them" (UP-01): agents can draft realistic tests without gaining any power the founder did not grant. Outcome: plans can create test data, check backend state and clean up, and no plan can change a call's service, method, headers or request shape.

## Scope and non-goals

- **In:**
  - **Call declarations** in `project.json`, under `calls`. Each declares:
    - a declared service (SPEC-02 `services`), a method and a path whose `{name}` placeholders fill whole segments;
    - query values, headers and a JSON body as templates;
    - typed parameters;
    - `effect: 'read' | 'write'` and the statuses that count as success;
    - named response `fields`, given as JSON pointers;
    - limits, and whether unapproved plans may make the call.
  - **Plan steps:** `call` (invoke a declaration and optionally remember response fields as SPEC-30 values) and `expectBackend` (invoke a `read` declaration and assert on one field). A plan-level `cleanup` list holds calls that run after the steps, whatever the outcome.
  - **Typed arguments.** Literal values or SPEC-30 value references, checked against the parameter type at parse time for literals and at run time for references. Secret parameters take only `{ secretName }`.
  - **Safe templating.** A parameter fills a whole JSON value (any type) or a whole path segment or query value (percent-encoded). Interpolation inside a string is allowed only for parameter types that cannot hold quotes, spaces or separators (`identifier`, `integer`, `yearMonthDay`, `oneOf` with values of those shapes). This makes SQL-over-HTTP declarations, such as a database admin API, injection-safe by construction.
  - **Execution** through a `ServiceCaller` port that `runner` implements, over the same egress proxy and resolve-time address check as the browser (SPEC-07). Redirects are not followed. Responses are size-capped.
  - **Policy** additions to the static gate (SPEC-03):
    - a plan with no approval may not make a `write` call unless its declaration sets `allowInProposals` (`side-effect-in-proposal`);
    - calls count toward `maximumCalls` (`over-limit`);
    - a service on a production origin is denied (`production-origin`).
  - **Failure semantics.**
    - A failed `call` ends the run `Errored`: it could not test, which is not a product failure. Cleanup still runs.
    - A failed `expectBackend` ends it `Failed`.
    - `read` calls in `expectBackend` are retried until they pass or `backendCheckTimeoutMilliseconds` runs out, which covers background jobs. `write` calls are never retried.
  - **Evidence and replay.**
    - Each call's record holds its name, method, service, status, timing and response sha256. Body excerpts are added only after redaction and only from SPEC-09 on. Header values are never recorded.
    - A run with calls lists `service-calls` in `nonHermeticInputs`.
    - Replay never repeats a call. It feeds the recorded responses to the engine, so values, check verdicts and later steps are reproduced.
  - **Compatibility with the later `http/v1` pack (SPEC-23):**
    - it uses the same `services` registry, `ServiceName`, `EgressPolicy.allowServices` route and `SecretStore`, so the pack adds no new trust route;
    - `ServiceCaller`, `ServiceRequest` and `ServiceResponse` live in `contracts`, so the pack's executor reuses them and core still imports no pack (AC-SPEC-23-04);
    - core step names hold no dot, so they cannot collide with pack step types such as `http.request/v1`;
    - the purposes differ. Declared calls are fixed, named setup and checks for browser tests. `http/v1` steps are plan-written API requests for API testing, enabled per project through `packs`. Both stay when the pack lands, and no plan migrates;
    - `BackendAssertion` is offered to the pack as its field-check vocabulary. If the pack needs more, it adds namespaced kinds of its own.
- **Non-goals:**
  - direct database connections and shell or script commands. They need database drivers on the trust path (new dependencies), run with the CI job's ambient authority outside egress control, and cannot be recorded or replayed. A team without an HTTP seeding route adds one to its test build; `docs/decisions/plan-language-extensions.md` gives the pattern;
  - plan-supplied URLs, methods, headers or bodies. That is `http/v1` (SPEC-23, phase 2b);
  - chaining a login call's token into another call's headers. Credentials come only from secret names (SPEC-04), so long-lived test tokens are declared as secrets;
  - multipart, form-encoded or binary request bodies, and field checks on non-JSON responses (status checks still work);
  - calls inside `frame` or `newTab` blocks, which are page scopes;
  - verifying that a `read` declaration really has no side effect. The person declares it, and core records the declaration.

## Interfaces and types

```ts
// contracts
export type CallName = Brand<string, 'CallName'>;                  // ^[a-z][A-Za-z0-9]{0,63}$
export type ParameterName = Brand<string, 'ParameterName'>;        // same pattern
export type FieldName = Brand<string, 'FieldName'>;                // same pattern
export type JsonPointer = Brand<string, 'JsonPointer'>;            // RFC 6901, "" or starting with "/"
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ParameterType =
  | { readonly kind: 'text'; readonly maximumLength: number }      // SafeText
  | { readonly kind: 'identifier' }                                // ^[A-Za-z_][A-Za-z0-9_]{0,62}$
  | { readonly kind: 'integer'; readonly minimum: number; readonly maximum: number }
  | { readonly kind: 'boolean' } | { readonly kind: 'email' } | { readonly kind: 'yearMonthDay' }
  | { readonly kind: 'oneOf'; readonly values: readonly string[] }
  | { readonly kind: 'secret' };                                   // argument must be { secretName }
// A JSON template. Object keys starting with "$" are reserved for the two placeholder forms below.
export type JsonTemplate = null | boolean | number | string | readonly JsonTemplate[]
  | { readonly [key: string]: JsonTemplate }
  | { readonly $parameter: ParameterName }                                         // a whole JSON value
  | { readonly $interpolate: string; readonly parameters: readonly ParameterName[] }; // "{name}" inside a string; safe types only
export type HeaderValue =
  | { readonly literal: SafeText }
  | { readonly secretName: SecretName; readonly scheme: 'bearer' | 'basic' | 'token' | 'raw' };
export type CallDeclaration = {
  readonly service: ServiceName; readonly method: HttpMethod;
  readonly path: string;                                           // starts with "/"; {name} fills a whole segment
  readonly query?: Readonly<Record<string, JsonTemplate>>;         // scalar results only
  readonly headers?: Readonly<Record<string, HeaderValue>>;        // never host, cookie, content-length, transfer-encoding,
                                                                   // connection, upgrade, te, trailer or proxy-*
  readonly body?: JsonTemplate;                                    // sent as application/json
  readonly parameters: Readonly<Record<ParameterName, ParameterType>>;
  readonly effect: 'read' | 'write';
  readonly successStatuses: readonly number[];                     // anything else: unexpected-status
  readonly fields?: Readonly<Record<FieldName, JsonPointer>>;
  readonly allowInProposals: boolean;                              // default false
  readonly timeoutMilliseconds?: number; readonly maximumResponseBytes?: number;   // defaults 10 s and 1 MiB
};
// ProjectData gains: calls: Readonly<Record<CallName, CallDeclaration>> (default {}).
// limits gain: maximumCalls (default 20, at most 200), backendCheckTimeoutMilliseconds (default 10000, at most 120000).

// Plan 1.2 additions (SPEC-30 owns the version):
export type CallArgument = TextOrValue | number | boolean | SecretReference;
export type CallArguments = Readonly<Record<ParameterName, CallArgument>>;
export type BackendAssertion =
  | { readonly kind: 'present' | 'absent' }
  | { readonly kind: 'equals' | 'contains'; readonly value: TextOrValue }
  | { readonly kind: 'numberEquals'; readonly value: number };
//  | { type: 'call'; call: CallName; arguments: CallArguments; remember?: Readonly<Record<ValueName, FieldName>> }
//  | { type: 'expectBackend'; call: CallName; arguments: CallArguments; field: FieldName; assert: BackendAssertion;
//      criterionId: CriterionId }                                  // the call must be declared effect: 'read'
// PlanData gains: cleanup?: readonly Extract<Step, { type: 'call' }>[]   // run in order after the steps, whatever the outcome

// The port. runner implements it through the egress proxy; cli wires it into RunPorts (SPEC-08 addition: services).
export type ServiceRequest = {
  readonly origin: Origin; readonly method: HttpMethod; readonly pathAndQuery: string;
  readonly headers: readonly { readonly name: string; readonly value: string | Secret }[];   // revealed only inside runner
  readonly body: string | null; readonly timeoutMilliseconds: number; readonly maximumResponseBytes: number;
};
export type ServiceResponse = { readonly status: number; readonly mediaType: string | null; readonly body: Uint8Array };
export interface ServiceCaller { call(request: ServiceRequest): Promise<Result<ServiceResponse, ServiceCallErrorCode>> }
export type ResponseReadErrorCode = 'response-not-json' | 'response-too-large' | 'field-missing';   // SPEC-33 reuses these
export type ServiceCallErrorCode = ResponseReadErrorCode
  | 'service-unreachable' | 'call-timeout' | 'unexpected-status' | 'egress-blocked' | 'parameter-invalid' | 'cleanup-failed';
// PlanErrorCode additions: 'unsafe_interpolation' | 'header_not_allowed'   (both raised while parsing project.json)
// PolicyRuleId addition (SPEC-03): 'side-effect-in-proposal'

// engine. Pure: builds the request from the declaration, arguments, run values and secrets; no I/O.
export function buildServiceRequest(declaration: CallDeclaration, service: { origin: Origin }, callArguments: CallArguments,
  values: RunValues, secrets: SecretStore): Result<ServiceRequest, 'parameter-invalid' | 'secret-missing'>;
```

**Rules the criteria rely on.**

- Undeclared names (call, field) and wrong arguments reuse the existing plan codes: `unknown_value`, `missing_field`, `unknown_field`, `wrong_type`, `too_long`, and `literal_secret` for a literal in a secret parameter. `expectBackend` on a `write` call fails with `unknown_value` at `.call`.
- `call` and `expectBackend` inside `frame` or `newTab`, and any step other than `call` in `cleanup`, fail with `misplaced_step` (SPEC-31).
- A cleanup call whose arguments name a value that was never set, because the run stopped first, is skipped and recorded `skipped`. A failing cleanup call is recorded `cleanup-failed`. It never changes the verdict, and it raises a review item.
- `runner`'s call module joins SPEC-04's `reveal` allow-list. No other new module does.
- At the `host` guarantee level (no egress enforcement), the caller still connects only to the declared service's origin, checked before connecting, and the run is labelled `host`.

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; `docs/decisions/answers.md`):

- **Services.** This spec brings the trusted `services` list forward from SPEC-23, in SPEC-02's shape `{ name, origin, private }`. A `ServiceName` is a lowercase letter, then up to 39 lowercase letters, digits or hyphens.
- **Running against a fake caller in M1.** `RunPorts.services` carries the `ServiceCaller`. When a plan calls a service and no caller is given, the run is refused before any side effect with refusal code `services-unavailable`. The real caller, through runner and the egress proxy, comes with SPEC-07.
- **Results.**
  - `RunResult.cleanup` lists each cleanup call's `outcome` and `code`.
  - `RunResult.reviewItems` holds `cleanup-failed` items.
- **Header schemes.** Engine applies the scheme to the secret's value:
  - `bearer`: `Bearer <value>`;
  - `basic`: `Basic` and the base64 of the value, which holds `user:password`;
  - `token`: the value as it is.
- **Run values as arguments.**
  - An integer must be decimal digits.
  - A boolean is the text `true` or `false`.
  - A path segment of `.` or `..` is `parameter-invalid`.
- **Limits.** Each call or backend-check step counts once toward `maximumCalls`, whatever its polls. Polls are bounded by the step's timeout.
- **Production.** A service whose origin is production follows SPEC-03's rule: only with `allowProductionForApprovedPlans`, and only for approved plans.
- **Cleanup** holds call steps only. Any other step there is `misplaced_step`.
- **Golden plan.** The shared test project gains the test service, its secret names and its declared calls, so the 1.2 golden plan for `call` parses (founder, 2026-10-28).

## Acceptance criteria

- AC-SPEC-32-01: When `project.json` declares a call, the project parser shall reject it with a code and path when (oracle: specified; one fixture per case):
  - its service is undeclared (`unknown_value`);
  - a path placeholder names no parameter or fills part of a segment (`unknown_value`);
  - a `text`, `email`, `boolean` or `secret` parameter is interpolated inside a string (`unsafe_interpolation`);
  - it sets a forbidden header (`header_not_allowed`);
  - a literal object key starts with "$" (`unknown_value`);
  - a field pointer is not a valid JSON pointer (`unknown_value`).
- AC-SPEC-32-02: When a plan names an undeclared call or field, omits or adds an argument, gives one of the wrong type, length or `oneOf` value, or puts a literal in a secret parameter, the parser shall reject it with the matching code and path. It shall echo no value, and zero calls shall be made (oracle: specified; at least one hostile plan per code).
- AC-SPEC-32-03: When `buildServiceRequest` runs over 1,000 generated argument sets, the origin, method, header names and path segment count shall always equal the declaration's (oracle: metamorphic). The sets include quotes, `'; DROP TABLE`, `{other}`, `../`, "%2F", JSON fragments and non-Latin text. In every case:
  - the body shall be valid JSON in which each text argument is exactly one string value;
  - SafeText shall already have refused CR and LF.
- AC-SPEC-32-04: When a remembered or generated value fails its parameter's type at run time, the step shall fail with `parameter-invalid` and no request shall be sent (oracle: specified).
- AC-SPEC-32-05: When a declared service resolves to a private, loopback, link-local or metadata address and is not declared private, the call shall fail with `egress-blocked` (oracle: specified; extends AC-SPEC-07-02). When the service answers with a redirect, the caller shall not follow it, and the status shall be judged against `successStatuses` (oracle: specified).
- AC-SPEC-32-06: When the static gate sees a plan with no approval that makes a `write` call whose declaration does not set `allowInProposals`, it shall deny the plan with `side-effect-in-proposal`. Calls plus cleanup over `maximumCalls` shall be denied with `over-limit`, and a service on a production origin with `production-origin`. In each case zero calls shall be made (oracle: specified).
- AC-SPEC-32-07: When a `call` step gets a status outside `successStatuses`, times out or cannot connect, the run shall end `Errored` with `unexpected-status`, `call-timeout` or `service-unreachable`. Later steps shall be skipped, and cleanup shall still run (oracle: specified).
- AC-SPEC-32-08: When a run passes, fails or errors, its cleanup calls shall run in order (oracle: specified):
  - one that needs a value never set shall be recorded `skipped`;
  - one that fails shall be recorded `cleanup-failed`, the verdict shall not change, and a review item shall be raised.
- AC-SPEC-32-09: When an `expectBackend` field matches only on the third poll, the step shall pass. When it never matches, the step shall fail with `assertion-failed` after `backendCheckTimeoutMilliseconds` (oracle: specified). A `write` call that times out shall have been sent exactly once (oracle: specified; the fixture service counts requests).
- AC-SPEC-32-10: When a response exceeds `maximumResponseBytes`, reading shall stop at the limit and the step shall fail with `response-too-large`. A non-JSON response read for a field shall fail with `response-not-json`, and a missing pointer with `field-missing` (oracle: specified).
- AC-SPEC-32-11: When the leak scan runs over a run whose calls used bearer and basic secrets, and whose responses echoed them, it shall find no echo in raw, base64 or URI form, and no header value shall be recorded (oracle: specified; extends AC-SPEC-04-04).
- AC-SPEC-32-12: When a declared secret cannot be resolved, the run shall end before any call with `secret-missing`, naming the secret and no value (oracle: specified; extends AC-SPEC-04-07). When a module outside `runner`'s call module imports `reveal`, lint shall fail (oracle: specified).
- AC-SPEC-32-13: When a run with calls is replayed 20 times, no call shall be sent, the recorded responses shall be fed to the engine, the result hashes shall be identical, and `nonHermeticInputs` shall list `service-calls` (oracle: regression).
- AC-SPEC-32-14: When the change under test adds or edits a call declaration, the run shall use the protected-branch `project.json` and raise `changed-with-code` naming the file (oracle: specified; extends AC-SPEC-02-02).
- AC-SPEC-32-15: When `contracts`, `engine` and `runner` are built, none shall have a new runtime dependency, and `contracts` and `engine` shall import no pack (oracle: specified; extends AC-SPEC-23-04).
- AC-SPEC-32-16: When the event of a run with calls is logged, it shall hold only the fields the logging manifest lists for call records (oracle: specified).

## Error codes

Add to SPEC-27's unions and give each a heading in `docs/errors.md`:

- plan codes `unsafe_interpolation` and `header_not_allowed`;
- the new `ServiceCallErrorCode` union: `response-not-json`, `response-too-large`, `field-missing`, `service-unreachable`, `call-timeout`, `unexpected-status`, `egress-blocked`, `parameter-invalid` and `cleanup-failed`.

Add `side-effect-in-proposal` to SPEC-03's `PolicyRuleId`, with a heading if policy rules are anchored by then.

## Dependencies

- SPEC-30 (plan 1.2, values, `TextOrValue`), SPEC-31 (`misplaced_step`), SPEC-02 (project file, `services`, trust), SPEC-03 (static gate), SPEC-04 (secrets, redaction, `reveal` allow-list), SPEC-27.
- SPEC-07 (egress proxy, `allowServices`, address check), SPEC-08 (`RunPorts.services`, replay of recorded responses), SPEC-09 (body excerpts, M3).
- SPEC-23: this spec pulls forward declared, named HTTP setup and checks only. Everything plan-written stays in `http/v1`.
- Research background: architecture (`04` Findings 1 and 3); API and integration (`05` Finding 1).

## Milestone

- **M1, after SPEC-02, SPEC-03 and SPEC-04:** declarations, project parser rules, plan grammar, `buildServiceRequest`, the policy additions, and tests against a fake `ServiceCaller`.
- **M2, with SPEC-07 and SPEC-08:** `runner`'s `ServiceCaller` through the egress proxy, and replay of recorded responses.
- **M3, with SPEC-09:** redacted body excerpts. Until then the evidence holds status, timing and hashes only.

## Satisfies

FR-01, FR-04, FR-05, NFR-03, NFR-04
