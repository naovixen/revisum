# SPEC-33: Declared network stubs, request checks and web storage

## Purpose

Some tests in the coverage study fake a failing endpoint, count the requests a page makes, compare the UI with a response, or prepare local or session storage. Their frameworks did this with page scripts and route handlers, which a closed plan may not hold. This spec adds those powers in the same form as SPEC-32: the trusted project file declares them by name, a person approves them (SPEC-02), and a plan only refers to them, with typed arguments. Drivers carry them out over CDP, with no script from the plan or the project. It serves "our end-to-end tests are flaky, so nobody trusts a red build" (UP-02): a stubbed failure is deterministic. It also serves "letting AI agents into our pipeline feels like handing over the keys" (UP-09): no plan can inject code, reach a new origin or read a storage key nobody declared. Outcome: plan 1.2 (SPEC-30) gains stub, request-check and storage steps. Nothing a stub serves can run in the page.

## Scope and non-goals

- **In:**
  - **Stubs.** A declaration names a request matcher (an allowed origin or declared service, a method, and an exact path or a path prefix) and a list of responses. Responses are served in order, and the last one repeats.
    - A response has a status, a media type from a closed list of data types, headers outside a deny-list, and a body. The body is a declared fixture file, a JSON template with typed parameters (SPEC-32), plain text, or empty.
    - The plan starts and stops a stub by name. Only fetch and XHR requests are stubbed, never documents, scripts, styles, frames, workers or images.
    - Every stubbed response carries `X-Content-Type-Options: nosniff`, so the browser cannot treat data as code.
  - **Request checks.** A declaration names a matcher and optional response fields (JSON pointers). From the start of the plan, the driver records each matching exchange: method, URL, status, media type and, only when fields are declared, a size-capped body.
    - The plan may reset the count, check it (`equals`, `atLeast`, `atMost`), check the latest response's status or a field, and remember a field as a SPEC-30 value: its text, or the length of an array.
    - `equals` and `atMost` wait until no matching request has been in flight for `requestQuietMilliseconds`, then compare.
  - **Web storage.** A declaration names an area (`local` or `session`), an allowed origin, a key and an access level (`read` or `readWrite`). For `readWrite` it also gives a value template with typed parameters.
    - The plan may write or remove a `readWrite` entry, and check that any declared entry is present, absent or equal to a value.
    - Writes go to the current page's storage through CDP's DOM storage domain, so they need no page script. The page must be on the declared origin.
    - Values read from storage are compared, never recorded.
  - **Proposals.** A plan with no approval may not start a stub or write storage unless the declaration sets `allowInProposals` (SPEC-32's `side-effect-in-proposal`).
  - **Service workers.** While any stub or request check is active, the driver bypasses service workers, so every request is seen and stubbed the same way.
- **Non-goals:**
  - arbitrary page scripts, and reading or writing an application's own in-memory state, such as an editor's data store. Both need code in the page, which breaks containment and ties tests to private internals;
  - stubbing documents, scripts, styles, frames or workers, or serving HTML, JavaScript, CSS, SVG or WebAssembly. Any of these would let a stub inject code;
  - WebSocket frames, server-sent event streams and cookies (cookies come from sign-in steps or saved storage state, SPEC-04);
  - IndexedDB and Cache Storage;
  - stubbing at the egress proxy. The proxy only allows or blocks; SPEC-07's ladder mutants stay there. Stubs live in the driver because HTTPS bodies can only be answered inside the browser without intercepting TLS;
  - request bodies in evidence, and checks on request bodies (later, if a pilot needs them).

## Interfaces and types

```ts
// contracts. JsonTemplate, ParameterType, ParameterName, FieldName, JsonPointer, HttpMethod, CallArguments and
// ResponseReadErrorCode are SPEC-32's; TextOrValue, ValueName and RememberSource are SPEC-30's.
export type StubName = Brand<string, 'StubName'>;                  // ^[a-z][A-Za-z0-9]{0,63}$
export type RequestName = Brand<string, 'RequestName'>;            // same pattern
export type StorageEntryName = Brand<string, 'StorageEntryName'>;  // same pattern
export type RequestMatcher = {
  readonly origin: Origin;                                         // an allowed origin or a declared service's origin
  readonly method: HttpMethod; readonly path: string; readonly match: 'exact' | 'prefix';  // compared without the query
};
export const STUB_MEDIA_TYPES = ['application/json', 'application/problem+json', 'text/plain', 'text/csv'] as const;
export type StubResponse = {
  readonly status: number;                                         // 200 to 599
  readonly mediaType: (typeof STUB_MEDIA_TYPES)[number];
  readonly headers?: Readonly<Record<string, SafeText>>;           // never set-cookie, location, refresh, content-type,
                                                                   // content-length, transfer-encoding, link, clear-site-data,
                                                                   // content-security-policy*, access-control-*, cross-origin-*,
                                                                   // permissions-policy, strict-transport-security,
                                                                   // service-worker-allowed, report-to or nel
  readonly body: { readonly fixture: FixtureName } | { readonly json: JsonTemplate } | { readonly text: SafeText } | null;
};
export type StubDeclaration = {
  readonly request: RequestMatcher; readonly parameters: Readonly<Record<ParameterName, ParameterType>>;
  readonly responses: readonly StubResponse[];                     // 1 to 20, in order; the last repeats
  readonly allowInProposals: boolean;
};
export type ObservedRequestDeclaration = {
  readonly request: RequestMatcher; readonly fields?: Readonly<Record<FieldName, JsonPointer>>;
  readonly maximumResponseBytes?: number;                          // default 256 KiB
};
export type StorageEntryDeclaration = {
  readonly area: 'local' | 'session'; readonly origin: Origin; readonly key: SafeText;
  readonly access: 'read' | 'readWrite';
  readonly value?: JsonTemplate;                                   // readWrite only; a string result is stored as is, anything else as JSON
  readonly parameters?: Readonly<Record<ParameterName, ParameterType>>;
  readonly allowInProposals: boolean;
};
// ProjectData gains: stubs, observedRequests, storageEntries: Readonly<Record<Name, Declaration>> (each default {}).
// limits gain: requestQuietMilliseconds (default 500, at most 5000).

export type RequestCount = { readonly equals: number } | { readonly atLeast: number } | { readonly atMost: number };
export type ResponseAssertion =
  | { readonly kind: 'statusEquals'; readonly value: number }
  | { readonly kind: 'fieldPresent' | 'fieldAbsent'; readonly field: FieldName }
  | { readonly kind: 'fieldEquals' | 'fieldContains'; readonly field: FieldName; readonly value: TextOrValue };
export type StorageAssertion = { readonly kind: 'present' | 'absent' } | { readonly kind: 'equals'; readonly value: TextOrValue };
// Plan 1.2 steps:
//  | { type: 'stub'; stub: StubName; action: 'start' | 'stop'; arguments?: CallArguments }   // arguments only with start
//  | { type: 'resetRequests'; request: RequestName }
//  | { type: 'expectRequests'; request: RequestName; count: RequestCount; criterionId: CriterionId }
//  | { type: 'expectResponse'; request: RequestName; assert: ResponseAssertion; criterionId: CriterionId }  // latest exchange
//  | { type: 'setStorage'; entry: StorageEntryName; arguments?: CallArguments }
//  | { type: 'removeStorage'; entry: StorageEntryName }
//  | { type: 'expectStorage'; entry: StorageEntryName; assert: StorageAssertion; criterionId: CriterionId }
// RememberSource gains: | { response: RequestName; field: FieldName; read: 'text' | 'arrayLength' }

// Driver port additions. The engine resolves templates and arguments; the driver receives finished bytes.
export type ResolvedStub = { readonly name: StubName; readonly request: RequestMatcher;
  readonly responses: readonly { status: number; mediaType: string; headers: readonly [string, string][]; body: Uint8Array }[] };
export type ObservedExchange = { readonly method: HttpMethod; readonly url: string; readonly status: number | null;
  readonly mediaType: string | null; readonly body: Uint8Array | null; readonly stubbed: StubName | null };
export interface NetworkPort {
  startStub(stub: ResolvedStub): Promise<Result<void, DriverError>>;
  stopStub(name: StubName): Promise<Result<void, DriverError>>;
  observe(name: RequestName, matcher: RequestMatcher, maximumResponseBytes: number | null): Promise<Result<void, DriverError>>;
  exchanges(name: RequestName): readonly ObservedExchange[];                 // since the plan's start or the last reset
  quiet(name: RequestName, quietMilliseconds: number, timeoutMilliseconds: number): Promise<Result<void, DriverError>>;
}
export interface StoragePort {
  write(area: 'local' | 'session', origin: Origin, key: string, value: string): Promise<Result<void, DriverError>>;
  remove(area: 'local' | 'session', origin: Origin, key: string): Promise<Result<void, DriverError>>;
  read(area: 'local' | 'session', origin: Origin, key: string): Promise<Result<string | null, DriverError>>;
}
// Session gains: network: NetworkPort; storage: StoragePort.
// DriverErrorCode addition: 'storage-origin-mismatch'.
// StepErrorCode addition (SPEC-30's union): 'request-not-seen'. Response reads reuse ResponseReadErrorCode (SPEC-32).
```

**Rules the criteria rely on.**

- Undeclared names, `setStorage` or `removeStorage` on a `read` entry, and arguments that don't fit the declaration reuse the existing plan codes (`unknown_value`, `missing_field`, `unknown_field`, `wrong_type`, `literal_secret`).
- The project parser rejects a matcher origin that is neither allowed nor a declared service with `origin_not_allowed`, and a denied stub header with `header_not_allowed`. It rejects a media type outside the list, or an undeclared fixture, with `unknown_value`.
- Stubs started inside a `frame` or `newTab` block apply to the whole browser context and stay active until stopped or the plan ends.
- A stubbed request never reaches the network, so it produces no egress event. The result records which stub and which response index answered each request.
- An `expectResponse` or response-sourced `remember` with no matching exchange, within the step timeout, fails with `request-not-seen`.
- Field values, storage values and response bodies pass the redactor before any of them reaches a log. Storage values never appear in a result, even on failure: only "present", "absent" or "differs".

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; `docs/decisions/answers.md`):

- **Shared test project.** It gains the test stub, the observed request and the storage entries, so the 1.2 golden plans parse (founder, 2026-10-28).
- **Plan refusals.**
  - Writing or removing a `read` storage entry: `unknown_value` at `.entry`.
  - Arguments on a stub stop or a `removeStorage`: `unknown_field` at `.arguments`.
  - Stopping a stub the plan never started: `unknown_value` at `.stub`.
  - `atLeast: 0`: `vacuous`.
- **Declaration refusals.**
  - A storage entry on an origin that isn't allowed: `origin_not_allowed`.
  - A value on a read entry: `unknown_field`.
  - A response count or status that isn't a whole number: `wrong_type`.
  - No responses: `empty`; more than 20: `too_large`.
  - A status outside 200 to 599: `unknown_value`.
  - A declaration that sets `x-content-type-options`: `header_not_allowed`, because engine always sends `nosniff` itself.
- **Proposals.** `removeStorage` is a storage write, so a proposal using it is `side-effect-in-proposal`, as `setStorage` is.

## Acceptance criteria

- AC-SPEC-33-01: When `project.json` declares a stub on an origin that is neither allowed nor a declared service, a denied header, a media type outside `STUB_MEDIA_TYPES` or an undeclared fixture, the project parser shall reject it with `origin_not_allowed`, `header_not_allowed` or `unknown_value` and its path (oracle: specified).
- AC-SPEC-33-02: When a plan names an undeclared stub, request or storage entry, writes a `read` entry, or gives arguments that don't fit the declaration, the parser shall reject it with the matching code and path, echoing no value, and zero driver calls shall be made (oracle: specified; at least one hostile plan per code).
- AC-SPEC-33-03: When a stub's fixture body holds `<script>` markup and is served as `application/json` with `nosniff`, the page's fetch shall receive it as data and no script shall run (oracle: specified; a script counter in the fixture). When a document, script, style, frame, worker or image request matches a stub's matcher, it shall not be stubbed and shall go to the network through the proxy (oracle: specified).
- AC-SPEC-33-04: When a stub with three responses answers five requests, they shall get responses 1, 2, 3, 3 and 3. After `stop`, requests shall reach the network. The result shall record the stub name and response index for each request, and 20 replays shall give identical result hashes (oracle: regression).
- AC-SPEC-33-05: When a stub answers a request, no egress event shall be recorded for it, and unstubbed requests shall still be allowed or blocked by the egress proxy (oracle: specified; extends AC-SPEC-07-01).
- AC-SPEC-33-06: On a fixture page with a service worker that answers its own requests, an active stub or request check shall still see and answer every matching request (oracle: specified).
- AC-SPEC-33-07: On a fixture page that sends exactly two matching requests, `equals 2` and `atLeast 1` shall pass and `equals 1` and `atMost 1` shall fail. After `resetRequests`, `equals 0` shall pass. The quiet window shall be honoured (oracle: specified).
- AC-SPEC-33-08: When `expectResponse` checks the latest exchange, `statusEquals` and `fieldEquals` shall pass and fail as expected (oracle: specified):
  - a body over the cap shall fail with `response-too-large`;
  - a non-JSON body read for a field with `response-not-json`;
  - a missing pointer with `field-missing`;
  - no matching exchange with `request-not-seen`.
- AC-SPEC-33-09: When `remember` reads a response field with `read: 'arrayLength'`, the value shall be the decimal length of the array, and a non-array shall fail with `field-missing` (oracle: specified).
- AC-SPEC-33-10: When `setStorage` runs, a later `expectStorage` shall see the value, and `removeStorage` shall make it absent (oracle: specified). When the page is on another origin, `setStorage` shall fail with `storage-origin-mismatch` and nothing shall be written (oracle: specified).
- AC-SPEC-33-11: When the leak scan runs over a run whose storage, observed bodies and stub arguments held planted secrets and canary personal data, it shall find no echo in the result, logs, events or report, including after a failed `expectStorage` (oracle: specified; extends AC-SPEC-04-04).
- AC-SPEC-33-12: When a plan with no approval starts a stub or writes a storage entry whose declaration does not set `allowInProposals`, the static gate shall deny it with `side-effect-in-proposal`, and nothing shall be dispatched (oracle: specified).
- AC-SPEC-33-13: When the change under test adds or edits a stub, request or storage declaration, the run shall use the protected-branch `project.json` and raise `changed-with-code` (oracle: specified; extends AC-SPEC-02-02).
- AC-SPEC-33-14: When any assertion runs while a stub is active, its step result shall list the active stub names, so the report (SPEC-12) can show that the check ran against a faked response and not the real backend (oracle: specified).
- AC-SPEC-33-15: When an adapter does not implement a feature in this spec, the step shall fail with `unsupported-step`, never with a partial result. The Playwright fallback may do so for every feature here (oracle: specified).

## Error codes

Add to SPEC-27's unions and give each a heading in `docs/errors.md`: driver code `storage-origin-mismatch`, and step code `request-not-seen`. Response reads reuse SPEC-32's codes; declarations reuse SPEC-32's `header_not_allowed`.

## Dependencies

- SPEC-30 (plan 1.2, values, `remember`), SPEC-31 (`misplaced_step`, scopes), SPEC-32 (templates, parameter types, arguments, response codes, `side-effect-in-proposal`), SPEC-02, SPEC-04, SPEC-27.
- SPEC-06: CDP `Fetch` (fulfil requests by resource type), `Network` (exchanges and bodies, `setBypassServiceWorker`) and `DOMStorage`. SPEC-07 (egress events prove stubbed requests stay local), SPEC-08 (replay).
- Research background: architecture (`04` Findings 1 and 7: in-browser routing is not egress control, so stubs only answer and never allow).

## Milestone

- **M1, with SPEC-32:** declarations, project parser rules, grammar and policy additions.
- **M2, with SPEC-06 and after SPEC-07:** the driver's network and storage ports, so the egress criteria can be checked. Not part of the M2 alpha exit.

## Satisfies

FR-01, FR-02, FR-05, NFR-01, NFR-04
