// Declared service calls: named HTTP calls that the trusted project declares, and that a plan may
// only invoke by name with arguments typed by the declaration. A plan can create test data, check
// backend state and clean up, but it can never choose a call's service, method, headers or request
// shape: those come only from the declaration a person approved.
//
// The port types (ServiceCaller, ServiceRequest, ServiceResponse) live here so that runner, which
// sends the requests through the egress proxy, needs nothing from the engine, and so that a later
// protocol pack can reuse them without core importing the pack.
// See docs/specs/SPEC-32-declared-service-calls.md.
import type { Brand } from './brand.ts';
import type { Result } from './result.ts';
import type { SafeText, SecretName, SecretReference, TextOrValue } from './plan.ts';
import type { Secret } from './secret.ts';
import type { Origin } from './target.ts';

// ---- The declared services ------------------------------------------------------------------

// A service's name, such as "shop": a lowercase letter, then up to 39 lowercase letters, digits or hyphens.
export type ServiceName = Brand<string, 'ServiceName'>;
// A backend the project declares. `private` says its origin may resolve to a private or loopback
// address, such as a test API on the CI machine; any other service that does is blocked.
export type DeclaredService = { readonly name: ServiceName; readonly origin: Origin; readonly private: boolean };

// ---- Call declarations ----------------------------------------------------------------------

// A declared call's name, such as "createOrder": a lowercase letter, then up to 63 letters and digits.
export type CallName = Brand<string, 'CallName'>;
// A call's parameter name, with the same pattern.
export type ParameterName = Brand<string, 'ParameterName'>;
// A response field a call declares, with the same pattern.
export type FieldName = Brand<string, 'FieldName'>;
// A JSON pointer (RFC 6901): "" for the whole document, or "/"-separated reference tokens.
export type JsonPointer = Brand<string, 'JsonPointer'>;

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const PARAMETER_KINDS = ['text', 'identifier', 'integer', 'boolean', 'email', 'yearMonthDay', 'oneOf', 'secret'] as const;
// What a parameter accepts. A text parameter holds safe text of at most maximumLength characters;
// an identifier is a letter or "_", then up to 62 letters, digits or "_"; a yearMonthDay is a
// real calendar day written "2026-11-02"; a secret parameter takes only { secretName }.
export type ParameterType =
  | { readonly kind: 'text'; readonly maximumLength: number }
  | { readonly kind: 'identifier' }
  | { readonly kind: 'integer'; readonly minimum: number; readonly maximum: number }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'email' }
  | { readonly kind: 'yearMonthDay' }
  | { readonly kind: 'oneOf'; readonly values: readonly SafeText[] }
  | { readonly kind: 'secret' };

// A JSON template for a body or a query value. Object keys starting with "$" are reserved for the
// two placeholder forms: a parameter filling a whole JSON value, or parameters written into a
// string at "{name}", which only types that cannot hold quotes, spaces or separators may do.
export type ParameterPlaceholder = { readonly $parameter: ParameterName };
export type InterpolatedString = { readonly $interpolate: string; readonly parameters: readonly ParameterName[] };
export type JsonTemplate =
  | null | boolean | number | string | readonly JsonTemplate[]
  | ParameterPlaceholder | InterpolatedString
  | { readonly [key: string]: JsonTemplate };

export const HEADER_SCHEMES = ['bearer', 'basic', 'token', 'raw'] as const;
// How a secret becomes a header value: bearer "Bearer <value>"; basic "Basic " and the base64 of
// the value, which holds "user:password"; token and raw the value as it is.
export type HeaderScheme = (typeof HEADER_SCHEMES)[number];
export type HeaderValue =
  | { readonly literal: SafeText }
  | { readonly secretName: SecretName; readonly scheme: HeaderScheme };

export const CALL_EFFECTS = ['read', 'write'] as const;
// read: the person declares the call changes nothing, so a backend check may repeat it.
// write: it changes something, so it is never retried, and a proposal may make it only when the
// declaration allows it in proposals.
export type CallEffect = (typeof CALL_EFFECTS)[number];

export type CallDeclaration = {
  readonly service: ServiceName;
  readonly method: HttpMethod;
  // Starts with "/". A "{name}" placeholder fills a whole segment.
  readonly path: string;
  // Each value a scalar once filled.
  readonly query?: Readonly<Record<string, JsonTemplate>>;
  // Never host, cookie, content-length, transfer-encoding, connection, upgrade, te, trailer or proxy-*.
  readonly headers?: Readonly<Record<string, HeaderValue>>;
  // Sent as application/json.
  readonly body?: JsonTemplate;
  readonly parameters: Readonly<Record<ParameterName, ParameterType>>;
  readonly effect: CallEffect;
  // Any other status fails the call with unexpected-status.
  readonly successStatuses: readonly number[];
  readonly fields?: Readonly<Record<FieldName, JsonPointer>>;
  readonly allowInProposals: boolean;
  // Defaults: 10 s and 1 MiB.
  readonly timeoutMilliseconds?: number;
  readonly maximumResponseBytes?: number;
};

// ---- What a plan writes -----------------------------------------------------------------------

// An argument: literal text or a run value, a number, a boolean, or a secret by name.
export type CallArgument = TextOrValue | number | boolean | SecretReference;
export type CallArguments = Readonly<Record<ParameterName, CallArgument>>;

export const BACKEND_ASSERTION_KINDS = ['present', 'absent', 'equals', 'contains', 'numberEquals'] as const;
// A check on one response field. present and absent ask whether the field's pointer resolves;
// equals and contains compare the field as text; numberEquals compares it as a JSON number.
export type BackendAssertion =
  | { readonly kind: 'present' | 'absent' }
  | { readonly kind: 'equals' | 'contains'; readonly value: TextOrValue }
  | { readonly kind: 'numberEquals'; readonly value: number };

// ---- The port ---------------------------------------------------------------------------------

// One request, built by the engine from a declaration alone. A header value from a secret stays an
// opaque Secret until runner's caller reveals it as it writes the header.
export type ServiceRequestHeader = { readonly name: string; readonly value: string | Secret };
// A JSON body, in parts: text parts are JSON text as it is sent, and each Secret part stands for its
// value written as one JSON string. A body with no secret is one text part. Every body has this one
// shape, and only runner's caller joins the parts, as it sends the request, so a secret never
// travels as plain text through the request.
export type JsonBodyWithSecrets = { readonly jsonParts: readonly (string | Secret)[] };
export type ServiceRequest = {
  readonly origin: Origin;
  readonly method: HttpMethod;
  // Starts with "/": the path, then "?" and the query when there is one.
  readonly pathAndQuery: string;
  readonly headers: readonly ServiceRequestHeader[];
  // Null for no body.
  readonly body: JsonBodyWithSecrets | null;
  readonly timeoutMilliseconds: number;
  readonly maximumResponseBytes: number;
};
export type ServiceResponse = { readonly status: number; readonly mediaType: string | null; readonly body: Uint8Array };

// Why reading a response failed: it is not JSON, it is larger than the declaration allows, or the
// field's pointer does not resolve.
export type ResponseReadErrorCode = 'response-not-json' | 'response-too-large' | 'field-missing';
// Why a call failed. Besides the reading errors: the service could not be reached, did not answer
// in time, answered with a status the declaration does not list, or resolved to an address the
// egress rules block; a run value did not fit its parameter; a cleanup call failed.
export type ServiceCallErrorCode = ResponseReadErrorCode
  | 'service-unreachable' | 'call-timeout' | 'unexpected-status' | 'egress-blocked' | 'parameter-invalid' | 'cleanup-failed';

// Sends one request and reads the response, up to the request's size cap. Redirects are never
// followed: a redirect is a status like any other.
export interface ServiceCaller {
  call(request: ServiceRequest): Promise<Result<ServiceResponse, ServiceCallErrorCode>>;
}
