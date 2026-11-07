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
// The engine resolves templates and arguments; a driver receives finished bytes, or the name of a
// fixture it reads from its own fixtures folder.
import type { Brand } from './brand.ts';
import type { Result } from './result.ts';
import type { CallArguments, FieldName, HttpMethod, JsonPointer, JsonTemplate, ParameterName, ParameterType } from './service-calls.ts';
import type { Origin } from './target.ts';
import type { DriverError } from './DriverError.ts';
import type { CriterionId } from './CriterionId.ts';
import type { FixtureName } from './FixtureName.ts';
import type { SafeText, TextOrValue } from './TextOrValue.ts';
import type { StepType } from './StepType.ts';

// ---- Declarations ---------------------------------------------------------------------------

// A declared stub's, observed request's or storage entry's name, such as "loginNeedsCode": a
// lowercase letter, then up to 63 letters and digits.
export type StubName = Brand<string, 'StubName'>;
export type RequestName = Brand<string, 'RequestName'>;
export type StorageEntryName = Brand<string, 'StorageEntryName'>;

export const PathMatch = {
  Exact: 'exact',
  Prefix: 'prefix',
} as const;
export type PathMatch = (typeof PathMatch)[keyof typeof PathMatch];
export const PATH_MATCHES: readonly PathMatch[] = Object.values(PathMatch);
// Which requests a stub answers or a request check records. The origin is an allowed origin or a
// declared service's. The path starts with "/" and is compared with the request's path, without
// its query: exactly, or as a plain text prefix.
export type RequestMatcher = {
  readonly origin: Origin;
  readonly method: HttpMethod;
  readonly path: string;
  readonly match: PathMatch;
};

// The only media types a stub may serve: data, never markup, script, style or anything a browser
// could run. Each is written exactly, with no parameters such as a charset.
export const StubMediaType = {
  Json: 'application/json',
  ProblemJson: 'application/problem+json',
  PlainText: 'text/plain',
  Csv: 'text/csv',
} as const;
export type StubMediaType = (typeof StubMediaType)[keyof typeof StubMediaType];
export const STUB_MEDIA_TYPES: readonly StubMediaType[] = Object.values(StubMediaType);

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

export const StorageArea = {
  Local: 'local',
  Session: 'session',
} as const;
export type StorageArea = (typeof StorageArea)[keyof typeof StorageArea];
export const STORAGE_AREAS: readonly StorageArea[] = Object.values(StorageArea);
// read: a plan may only check the entry. readWrite: it may also write and remove it.
export const StorageAccess = {
  Read: 'read',
  ReadWrite: 'readWrite',
} as const;
export type StorageAccess = (typeof StorageAccess)[keyof typeof StorageAccess];
export const STORAGE_ACCESS: readonly StorageAccess[] = Object.values(StorageAccess);
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

export const StubAction = {
  Start: 'start',
  Stop: 'stop',
} as const;
export type StubAction = (typeof StubAction)[keyof typeof StubAction];
export const STUB_ACTIONS: readonly StubAction[] = Object.values(StubAction);

// How many matching requests a check expects. atLeast is at least 1: any page sends at least 0.
export const RequestCountKind = {
  Equals: 'equals',
  AtLeast: 'atLeast',
  AtMost: 'atMost',
} as const;
export type RequestCountKind = (typeof RequestCountKind)[keyof typeof RequestCountKind];
export const REQUEST_COUNT_KINDS: readonly RequestCountKind[] = Object.values(RequestCountKind);
export type RequestCount = { readonly equals: number } | { readonly atLeast: number } | { readonly atMost: number };

export const ResponseFieldPresenceKind = {
  FieldPresent: 'fieldPresent',
  FieldAbsent: 'fieldAbsent',
} as const;
export type ResponseFieldPresenceKind = (typeof ResponseFieldPresenceKind)[keyof typeof ResponseFieldPresenceKind];
export const RESPONSE_FIELD_PRESENCE_KINDS: readonly ResponseFieldPresenceKind[] = Object.values(ResponseFieldPresenceKind);
export const ResponseFieldTextKind = {
  FieldEquals: 'fieldEquals',
  FieldContains: 'fieldContains',
} as const;
export type ResponseFieldTextKind = (typeof ResponseFieldTextKind)[keyof typeof ResponseFieldTextKind];
export const RESPONSE_FIELD_TEXT_KINDS: readonly ResponseFieldTextKind[] = Object.values(ResponseFieldTextKind);
export const ResponseAssertionKind = {
  StatusEquals: 'statusEquals',
  ...ResponseFieldPresenceKind,
  ...ResponseFieldTextKind,
} as const;
export type ResponseAssertionKind = (typeof ResponseAssertionKind)[keyof typeof ResponseAssertionKind];
export const RESPONSE_ASSERTION_KINDS: readonly ResponseAssertionKind[] = Object.values(ResponseAssertionKind);
// A check on the latest matching exchange: its status, or one of the fields the request declares.
export type ResponseAssertion =
  | { readonly kind: typeof ResponseAssertionKind.StatusEquals; readonly value: number }
  | { readonly kind: ResponseFieldPresenceKind; readonly field: FieldName }
  | { readonly kind: ResponseFieldTextKind; readonly field: FieldName; readonly value: TextOrValue };

export const StorageAssertionKind = {
  Present: 'present',
  Absent: 'absent',
  Equals: 'equals',
} as const;
export type StorageAssertionKind = (typeof StorageAssertionKind)[keyof typeof StorageAssertionKind];
export const STORAGE_ASSERTION_KINDS: readonly StorageAssertionKind[] = Object.values(StorageAssertionKind);
// A check on a storage entry. The value read is compared, never recorded.
export type StorageAssertion =
  | { readonly kind: typeof StorageAssertionKind.Present | typeof StorageAssertionKind.Absent }
  | { readonly kind: typeof StorageAssertionKind.Equals; readonly value: TextOrValue };

// How a remember step reads a response field: its text, or the decimal length of an array.
export const ResponseRead = {
  Text: 'text',
  ArrayLength: 'arrayLength',
} as const;
export type ResponseRead = (typeof ResponseRead)[keyof typeof ResponseRead];
export const RESPONSE_READS: readonly ResponseRead[] = Object.values(ResponseRead);

// The plan steps of this file, as plan.ts's Step union holds them.
export type StubStep = { readonly type: typeof StepType.Stub; readonly stub: StubName; readonly action: StubAction; readonly arguments?: CallArguments };
export type ResetRequestsStep = { readonly type: typeof StepType.ResetRequests; readonly request: RequestName };
export type ExpectRequestsStep = {
  readonly type: typeof StepType.ExpectRequests; readonly request: RequestName; readonly count: RequestCount; readonly criterionId: CriterionId;
};
export type ExpectResponseStep = {
  readonly type: typeof StepType.ExpectResponse; readonly request: RequestName; readonly assert: ResponseAssertion; readonly criterionId: CriterionId;
};
export type SetStorageStep = { readonly type: typeof StepType.SetStorage; readonly entry: StorageEntryName; readonly arguments?: CallArguments };
export type RemoveStorageStep = { readonly type: typeof StepType.RemoveStorage; readonly entry: StorageEntryName };
export type ExpectStorageStep = {
  readonly type: typeof StepType.ExpectStorage; readonly entry: StorageEntryName; readonly assert: StorageAssertion; readonly criterionId: CriterionId;
};
export type NetworkAndStorageStep =
  | StubStep | ResetRequestsStep | ExpectRequestsStep | ExpectResponseStep | SetStorageStep | RemoveStorageStep | ExpectStorageStep;

// ---- The driver ports -------------------------------------------------------------------------

// A stub response as the driver serves it. The engine has filled every template, so the body is
// finished bytes, or a file from the project's fixtures folder, which the driver reads itself and
// never from outside that folder. The driver adds the media type as content-type and always sends
// X-Content-Type-Options: nosniff.
export type ResolvedStubResponse = {
  readonly status: number;
  readonly mediaType: StubMediaType;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array | { readonly fixture: FixtureName };
};
export type ResolvedStub = { readonly name: StubName; readonly request: RequestMatcher; readonly responses: readonly ResolvedStubResponse[] };
// Which stub answered one request, and with which of its responses, counted from 1. The last
// response repeats, so every answer after it gives its number again.
export type StubAnswer = { readonly stub: StubName; readonly responseIndex: number };
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
  // Starts answering the requests the stub matches; a stub started again starts from its first
  // response. Only fetch and XHR requests are answered: every other request goes to the network.
  startStub(stub: ResolvedStub): Promise<Result<void, DriverError>>;
  stopStub(name: StubName): Promise<Result<void, DriverError>>;
  // Every answer the session's stubs gave, in the order they gave them.
  stubAnswers(): readonly StubAnswer[];
  // Starts recording the exchanges the matcher matches, or, for a name already recorded, starts
  // again from nothing: a reset. Without a size cap no body is kept.
  observe(name: RequestName, matcher: RequestMatcher, maximumResponseBytes: number | null): Promise<Result<void, DriverError>>;
  // The finished exchanges since the observation started or was last reset, in the order they
  // finished. One that got no response, such as a refused connection, has a null status: the page
  // still sent it. A body over the cap is kept only up to one byte past it, so a reader can tell.
  exchanges(name: RequestName): readonly ObservedExchange[];
  // Resolves once no matching request has been in flight for quietMilliseconds, counted from the
  // call at the earliest; fails with timeout after timeoutMilliseconds.
  quiet(name: RequestName, quietMilliseconds: number, timeoutMilliseconds: number): Promise<Result<void, DriverError>>;
}
export interface StoragePort {
  // Fails with storage-origin-mismatch, writing nothing, when the session's page is not on the origin.
  write(area: StorageArea, origin: Origin, key: string, value: string): Promise<Result<void, DriverError>>;
  remove(area: StorageArea, origin: Origin, key: string): Promise<Result<void, DriverError>>;
  // Null when the entry is absent.
  read(area: StorageArea, origin: Origin, key: string): Promise<Result<string | null, DriverError>>;
}
