// Declared service calls: named HTTP calls that the trusted project declares, and that a plan may
// only invoke by name with arguments typed by the declaration. A plan can create test data, check
// backend state and clean up, but it can never choose a call's service, method, headers or request
// shape: those come only from the declaration a person approved.
//
// The port types (ServiceCaller, ServiceRequest, ServiceResponse) live here so that runner, which
// sends the requests through the egress proxy, needs nothing from the engine, and so that a later
// protocol pack can reuse them without core importing the pack.
import type { Brand } from "../../foundation/Brand.ts";
import type { Result } from "../../foundation/Result.ts";
import type { Secret } from "../../ports/Secret.ts";
import type { Origin } from "../../ports/Target.ts";
import type { SafeText, TextOrValue } from "../TextOrValue.ts";
import type { SecretName, SecretReference } from "../SecretName.ts";

// ---- The declared services ------------------------------------------------------------------

// A service's name, such as "shop": a lowercase letter, then up to 39 lowercase letters, digits or hyphens.
export type ServiceName = Brand<string, "ServiceName">;
// A backend the project declares. `private` says its origin may resolve to a private or loopback
// address, such as a test API on the CI machine; any other service that does is blocked. `port`
// is the one TCP port a database command may reach on the service's host; a database command's
// service must have one. Absent for a service that declares none.
export type DeclaredService = {
    readonly name: ServiceName;
    readonly origin: Origin;
    readonly private: boolean;
    readonly port?: number;
};

// ---- Call declarations ----------------------------------------------------------------------

// A declared call's name, such as "createOrder": a lowercase letter, then up to 63 letters and digits.
export type CallName = Brand<string, "CallName">;
// A call's parameter name, with the same pattern.
export type ParameterName = Brand<string, "ParameterName">;
// A response field a call declares, with the same pattern.
export type FieldName = Brand<string, "FieldName">;
// A JSON pointer (RFC 6901): "" for the whole document, or "/"-separated reference tokens.
export type JsonPointer = Brand<string, "JsonPointer">;

export const HttpMethod = {
    Get: "GET",
    Head: "HEAD",
    Post: "POST",
    Put: "PUT",
    Patch: "PATCH",
    Delete: "DELETE",
} as const;
export type HttpMethod = (typeof HttpMethod)[keyof typeof HttpMethod];
export const HTTP_METHODS: readonly HttpMethod[] = Object.values(HttpMethod);

export const ParameterKind = {
    Text: "text",
    Identifier: "identifier",
    Integer: "integer",
    Boolean: "boolean",
    Email: "email",
    YearMonthDay: "yearMonthDay",
    OneOf: "oneOf",
    Secret: "secret",
} as const;
export type ParameterKind = (typeof ParameterKind)[keyof typeof ParameterKind];
export const PARAMETER_KINDS: readonly ParameterKind[] = Object.values(ParameterKind);
// What a parameter accepts. A text parameter holds safe text of at most maximumLength characters;
// an identifier is a letter or "_", then up to 62 letters, digits or "_"; a yearMonthDay is a
// real calendar day written "2026-11-02"; a secret parameter takes only { secretName }.
export type ParameterType =
    | { readonly kind: typeof ParameterKind.Text; readonly maximumLength: number }
    | { readonly kind: typeof ParameterKind.Identifier }
    | {
          readonly kind: typeof ParameterKind.Integer;
          readonly minimum: number;
          readonly maximum: number;
      }
    | { readonly kind: typeof ParameterKind.Boolean }
    | { readonly kind: typeof ParameterKind.Email }
    | { readonly kind: typeof ParameterKind.YearMonthDay }
    | { readonly kind: typeof ParameterKind.OneOf; readonly values: readonly SafeText[] }
    | { readonly kind: typeof ParameterKind.Secret };

// A JSON template for a body or a query value. Object keys starting with "$" are reserved for the
// two placeholder forms: a parameter filling a whole JSON value, or parameters written into a
// string at "{name}", which only types that cannot hold quotes, spaces or separators may do.
export type ParameterPlaceholder = { readonly $parameter: ParameterName };
export type InterpolatedString = {
    readonly $interpolate: string;
    readonly parameters: readonly ParameterName[];
};
export type JsonTemplate =
    | null
    | boolean
    | number
    | string
    | readonly JsonTemplate[]
    | ParameterPlaceholder
    | InterpolatedString
    | { readonly [key: string]: JsonTemplate };

// How a secret becomes a header value: bearer "Bearer <value>"; basic "Basic " and the base64 of
// the value, which holds "user:password"; token and raw the value as it is.
export const HeaderScheme = {
    Bearer: "bearer",
    Basic: "basic",
    Token: "token",
    Raw: "raw",
} as const;
export type HeaderScheme = (typeof HeaderScheme)[keyof typeof HeaderScheme];
export const HEADER_SCHEMES: readonly HeaderScheme[] = Object.values(HeaderScheme);
export type HeaderValue =
    | { readonly literal: SafeText }
    | { readonly secretName: SecretName; readonly scheme: HeaderScheme };

// read: the person declares the call changes nothing, so a backend check may repeat it.
// write: it changes something, so it is never retried, and a proposal may make it only when the
// declaration allows it in proposals.
export const CallEffect = {
    Read: "read",
    Write: "write",
} as const;
export type CallEffect = (typeof CallEffect)[keyof typeof CallEffect];
export const CALL_EFFECTS: readonly CallEffect[] = Object.values(CallEffect);

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
    // Any other status fails a call with unexpected-status, pending statuses included. A backend check
    // stops on any other status too, with unexpected-status, or service-unreachable for a 502, 503 or
    // 504, which says a gateway could not get an answer, unless it is a pending status.
    readonly successStatuses: readonly number[];
    // Read calls only, and never a status of successStatuses. Statuses that mean "not ready yet": a
    // backend check polls on them under its timeout without reading the body. A plain call ignores
    // them. At the timeout the last status decides: 502, 503 or 504 ends the run Errored, any other
    // Failed.
    readonly pendingStatuses?: readonly number[];
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

export const BackendAssertionKind = {
    Present: "present",
    Absent: "absent",
    Equals: "equals",
    Contains: "contains",
    NumberEquals: "numberEquals",
} as const;
export type BackendAssertionKind = (typeof BackendAssertionKind)[keyof typeof BackendAssertionKind];
export const BACKEND_ASSERTION_KINDS: readonly BackendAssertionKind[] =
    Object.values(BackendAssertionKind);
// A check on one response field. present and absent ask whether the field's pointer resolves;
// equals and contains compare the field as text; numberEquals compares it as a JSON number.
export type BackendAssertion =
    | { readonly kind: typeof BackendAssertionKind.Present | typeof BackendAssertionKind.Absent }
    | {
          readonly kind: typeof BackendAssertionKind.Equals | typeof BackendAssertionKind.Contains;
          readonly value: TextOrValue;
      }
    | { readonly kind: typeof BackendAssertionKind.NumberEquals; readonly value: number };

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
export type ServiceResponse = {
    readonly status: number;
    readonly mediaType: string | null;
    readonly body: Uint8Array;
};

// Why reading a response failed: it is not JSON, it is larger than the declaration allows, or the
// field's pointer does not resolve.
export const ResponseReadErrorCode = {
    ResponseNotJson: "response-not-json",
    ResponseTooLarge: "response-too-large",
    FieldMissing: "field-missing",
} as const;
export type ResponseReadErrorCode =
    (typeof ResponseReadErrorCode)[keyof typeof ResponseReadErrorCode];
// Why a call failed. Besides the reading errors: the service could not be reached, did not answer
// in time, answered with a status the declaration does not list, or resolved to an address the
// egress rules block; a run value did not fit its parameter; a cleanup call failed.
export const ServiceCallErrorCode = {
    ...ResponseReadErrorCode,
    ServiceUnreachable: "service-unreachable",
    CallTimeout: "call-timeout",
    UnexpectedStatus: "unexpected-status",
    EgressBlocked: "egress-blocked",
    ParameterInvalid: "parameter-invalid",
    CleanupFailed: "cleanup-failed",
} as const;
export type ServiceCallErrorCode = (typeof ServiceCallErrorCode)[keyof typeof ServiceCallErrorCode];

// Sends one request and reads the response, to one byte past the request's size cap: a longer body
// answers with its status and the body cut there, for whoever set the cap to refuse. Redirects are
// never followed: a redirect is a status like any other.
export interface ServiceCaller {
    call(request: ServiceRequest): Promise<Result<ServiceResponse, ServiceCallErrorCode>>;
}
