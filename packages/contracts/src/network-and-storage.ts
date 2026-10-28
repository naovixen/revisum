// Declared network stubs, request checks and web storage: powers the trusted project declares by
// name, and that a plan may only use by that name, with arguments typed by the declaration.
//
//   - A stub answers the page's fetch and XHR requests that match its request matcher with the
//     responses a person declared, in order, the last one repeating. A stub only ever serves data
//     media types, with nosniff, so nothing it serves can run in the page.
//   - An observed request is a matcher whose exchanges the driver records, so a plan may count
//     them and check or remember fields of the latest response.
//   - A storage entry is one local or session storage key on an allowed origin, which a plan may
//     check, and write or remove only when the declaration gives readWrite access.
//
// The port types (NetworkPort, StoragePort) live here so drivers need nothing from the engine.
// The engine resolves templates and arguments; a driver receives finished bytes.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import type { Brand } from './brand.ts';
import type { DriverError } from './browser-driver.ts';
import type { CriterionId, FixtureName, SafeText, TextOrValue } from './plan.ts';
import type { Result } from './result.ts';
import type { CallArguments, FieldName, HttpMethod, JsonPointer, JsonTemplate, ParameterName, ParameterType } from './service-calls.ts';
import type { Origin } from './target.ts';

// ---- Declarations ---------------------------------------------------------------------------

// A declared stub's, observed request's or storage entry's name, such as "loginNeedsCode": a
// lowercase letter, then up to 63 letters and digits.
export type StubName = Brand<string, 'StubName'>;
export type RequestName = Brand<string, 'RequestName'>;
export type StorageEntryName = Brand<string, 'StorageEntryName'>;

export const PATH_MATCHES = ['exact', 'prefix'] as const;
// Which requests a stub answers or a request check records. The origin is an allowed origin or a
// declared service's. The path starts with "/" and is compared with the request's path, without
// its query: exactly, or as a plain text prefix.
export type RequestMatcher = {
  readonly origin: Origin;
  readonly method: HttpMethod;
  readonly path: string;
  readonly match: (typeof PATH_MATCHES)[number];
};

// The only media types a stub may serve: data, never markup, script, style or anything a browser
// could run. Each is written exactly, with no parameters such as a charset.
export const STUB_MEDIA_TYPES = ['application/json', 'application/problem+json', 'text/plain', 'text/csv'] as const;
export type StubMediaType = (typeof STUB_MEDIA_TYPES)[number];

// What a stub response's body is: a file from the project's fixtures folder, a JSON template filled
// from the stub's parameters, plain text, or nothing.
export type StubResponseBody = { readonly fixture: FixtureName } | { readonly json: JsonTemplate } | { readonly text: SafeText } | null;
export type StubResponse = {
  // 200 to 599.
  readonly status: number;
  readonly mediaType: StubMediaType;
  // Never a header that changes how the browser treats the response, such as set-cookie,
  // location, content-type, content-security-policy or access-control-*; never
  // x-content-type-options, which the engine always sets to nosniff itself.
  readonly headers?: Readonly<Record<string, SafeText>>;
  readonly body: StubResponseBody;
};
export type StubDeclaration = {
  readonly request: RequestMatcher;
  readonly parameters: Readonly<Record<ParameterName, ParameterType>>;
  // 1 to 20, served in order; the last one repeats.
  readonly responses: readonly StubResponse[];
  // Whether a plan with no approval may start the stub.
  readonly allowInProposals: boolean;
};

export type ObservedRequestDeclaration = {
  readonly request: RequestMatcher;
  // The response fields a plan may check or remember, as JSON pointers. Without fields, no
  // response body is kept: the requests are only counted.
  readonly fields?: Readonly<Record<FieldName, JsonPointer>>;
  // How much of a response body is kept for reading fields. 256 KiB unless the declaration says.
  readonly maximumResponseBytes: number;
};

export const STORAGE_AREAS = ['local', 'session'] as const;
export type StorageArea = (typeof STORAGE_AREAS)[number];
// read: a plan may only check the entry. readWrite: it may also write and remove it.
export const STORAGE_ACCESS = ['read', 'readWrite'] as const;
export type StorageAccess = (typeof STORAGE_ACCESS)[number];
export type StorageEntryDeclaration = {
  readonly area: StorageArea;
  // An allowed origin: the page must be on it for a write.
  readonly origin: Origin;
  readonly key: SafeText;
  readonly access: StorageAccess;
  // readWrite only, and then required. A string result is stored as it is, anything else as JSON.
  readonly value?: JsonTemplate;
  readonly parameters?: Readonly<Record<ParameterName, ParameterType>>;
  // Whether a plan with no approval may write or remove the entry.
  readonly allowInProposals: boolean;
};

// ---- What a plan writes -----------------------------------------------------------------------

export const STUB_ACTIONS = ['start', 'stop'] as const;
export type StubAction = (typeof STUB_ACTIONS)[number];

// How many matching requests a check expects. atLeast is at least 1: any page sends at least 0.
export const REQUEST_COUNT_KINDS = ['equals', 'atLeast', 'atMost'] as const;
export type RequestCount = { readonly equals: number } | { readonly atLeast: number } | { readonly atMost: number };

export const RESPONSE_FIELD_PRESENCE_KINDS = ['fieldPresent', 'fieldAbsent'] as const;
export const RESPONSE_FIELD_TEXT_KINDS = ['fieldEquals', 'fieldContains'] as const;
export const RESPONSE_ASSERTION_KINDS = ['statusEquals', ...RESPONSE_FIELD_PRESENCE_KINDS, ...RESPONSE_FIELD_TEXT_KINDS] as const;
// A check on the latest matching exchange: its status, or one of the fields the request declares.
export type ResponseAssertion =
  | { readonly kind: 'statusEquals'; readonly value: number }
  | { readonly kind: (typeof RESPONSE_FIELD_PRESENCE_KINDS)[number]; readonly field: FieldName }
  | { readonly kind: (typeof RESPONSE_FIELD_TEXT_KINDS)[number]; readonly field: FieldName; readonly value: TextOrValue };

export const STORAGE_ASSERTION_KINDS = ['present', 'absent', 'equals'] as const;
// A check on a storage entry. The value read is compared, never recorded.
export type StorageAssertion = { readonly kind: 'present' | 'absent' } | { readonly kind: 'equals'; readonly value: TextOrValue };

// How a remember step reads a response field: its text, or the decimal length of an array.
export const RESPONSE_READS = ['text', 'arrayLength'] as const;
export type ResponseRead = (typeof RESPONSE_READS)[number];

// The plan steps of this file, as plan.ts's Step union holds them.
export type StubStep = { readonly type: 'stub'; readonly stub: StubName; readonly action: StubAction; readonly arguments?: CallArguments };
export type ResetRequestsStep = { readonly type: 'resetRequests'; readonly request: RequestName };
export type ExpectRequestsStep = {
  readonly type: 'expectRequests'; readonly request: RequestName; readonly count: RequestCount; readonly criterionId: CriterionId;
};
export type ExpectResponseStep = {
  readonly type: 'expectResponse'; readonly request: RequestName; readonly assert: ResponseAssertion; readonly criterionId: CriterionId;
};
export type SetStorageStep = { readonly type: 'setStorage'; readonly entry: StorageEntryName; readonly arguments?: CallArguments };
export type RemoveStorageStep = { readonly type: 'removeStorage'; readonly entry: StorageEntryName };
export type ExpectStorageStep = {
  readonly type: 'expectStorage'; readonly entry: StorageEntryName; readonly assert: StorageAssertion; readonly criterionId: CriterionId;
};
export type NetworkAndStorageStep =
  | StubStep | ResetRequestsStep | ExpectRequestsStep | ExpectResponseStep | SetStorageStep | RemoveStorageStep | ExpectStorageStep;

// ---- The driver ports -------------------------------------------------------------------------
// The CDP driver implements these with SPEC-06; until then a run reports every step above as
// unsupported-step and nothing of it reaches a driver.

export type ResolvedStubResponse = {
  readonly status: number;
  readonly mediaType: StubMediaType;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
};
export type ResolvedStub = { readonly name: StubName; readonly request: RequestMatcher; readonly responses: readonly ResolvedStubResponse[] };
// One recorded request and its response. The body is kept only when the declaration names fields,
// up to its size cap.
export type ObservedExchange = {
  readonly method: HttpMethod;
  readonly url: string;
  readonly status: number | null;
  readonly mediaType: string | null;
  readonly body: Uint8Array | null;
  // The stub that answered it, or null when it went to the network.
  readonly stubbed: StubName | null;
};
export interface NetworkPort {
  startStub(stub: ResolvedStub): Promise<Result<void, DriverError>>;
  stopStub(name: StubName): Promise<Result<void, DriverError>>;
  observe(name: RequestName, matcher: RequestMatcher, maximumResponseBytes: number | null): Promise<Result<void, DriverError>>;
  // Since the plan's start or the last reset.
  exchanges(name: RequestName): readonly ObservedExchange[];
  quiet(name: RequestName, quietMilliseconds: number, timeoutMilliseconds: number): Promise<Result<void, DriverError>>;
}
export interface StoragePort {
  write(area: StorageArea, origin: Origin, key: string, value: string): Promise<Result<void, DriverError>>;
  remove(area: StorageArea, origin: Origin, key: string): Promise<Result<void, DriverError>>;
  read(area: StorageArea, origin: Origin, key: string): Promise<Result<string | null, DriverError>>;
}
