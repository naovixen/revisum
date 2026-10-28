// Reads the trusted project's declared stubs, observed requests and storage entries. A person
// declares each stub (a request matcher and the responses it serves, in order), each observed
// request (a matcher and the response fields a plan may read) and each storage entry (area,
// origin, key, access and, for a write, its value). The parser refuses a matcher on an origin that
// is neither allowed nor a declared service's, a stub response that could carry code or change
// how the browser treats it, and a fixture or parameter nobody declared, so every stub it accepts
// serves data only.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import {
  HTTP_METHODS, PATH_MATCHES, STORAGE_ACCESS, STORAGE_AREAS, STUB_MEDIA_TYPES,
  type FixtureName, type JsonTemplate, type ObservedRequestDeclaration, type Origin, type ParameterName, type ParameterType,
  type RequestMatcher, type RequestName, type SafeText, type StorageEntryDeclaration, type StorageEntryName, type StubDeclaration, type StubName,
  type StubResponse, type StubResponseBody,
} from '@revisum/contracts';
import {
  INVALID, allValid, peekRecord, readInteger, readList, readOneOf, readRecord, readText, type Issues, type Parsed,
} from '../plan/plan-decoders.ts';
import { HEADER_NAME, readDeclarationSection, readFields, readJsonTemplate, readParameters } from './call-declarations.ts';
import { readOrigin } from './project-parser.ts';

// What a declaration may refer to: the origins a matcher may name, and the fixture files a stub may serve.
export type NetworkDeclarationContext = {
  readonly issues: Issues;
  // The project's allowed origins. A storage entry must be on one of these.
  readonly origins: readonly Origin[];
  // The origins of the project's declared services, which a matcher may also name.
  readonly serviceOrigins: readonly Origin[];
  readonly fixtures: readonly FixtureName[];
};

const MAXIMUM_DECLARATIONS = 256;
const MAXIMUM_STUB_RESPONSES = 20;
// A stub may answer with a success, a redirect-free client error or a server error: never an
// informational status, which a fetch cannot receive.
const STUB_STATUS = { lowest: 200, highest: 599 } as const;
const MAXIMUM_MATCHER_PATH_LENGTH = 2048;
const MAXIMUM_HEADER_VALUE_LENGTH = 1024;
const MAXIMUM_TEXT_BODY_LENGTH = 64 * 1024;
const MAXIMUM_STORAGE_KEY_LENGTH = 1024;
const DEFAULT_OBSERVED_RESPONSE_BYTES = 256 * 1024;
const MAXIMUM_OBSERVED_RESPONSE_BYTES = 16 * 1024 * 1024;
// A matcher path: "/" and then anything but a query, a fragment or white space, which the path
// of a request never holds.
const MATCHER_PATH = /^\/[^?#\s]*$/;

// Stub response headers that change how the browser treats a response: where it goes, how it is
// read, what it may run or reach, and what the browser keeps. x-content-type-options is here
// because the engine always sends nosniff itself, so a declaration may neither set nor weaken it.
const DENIED_STUB_HEADERS: readonly string[] = [
  'set-cookie', 'location', 'refresh', 'content-type', 'content-length', 'transfer-encoding', 'link', 'clear-site-data',
  'permissions-policy', 'strict-transport-security', 'service-worker-allowed', 'report-to', 'nel', 'x-content-type-options',
];
const DENIED_STUB_HEADER_PREFIXES: readonly string[] = ['content-security-policy', 'access-control-', 'cross-origin-'];

const STUB_FIELDS = ['request', 'parameters', 'responses', 'allowInProposals'] as const;
const STUB_RESPONSE_FIELDS = ['status', 'mediaType', 'headers', 'body'] as const;
const OBSERVED_REQUEST_FIELDS = ['request', 'fields', 'maximumResponseBytes'] as const;
const STORAGE_ENTRY_FIELDS = ['area', 'origin', 'key', 'access', 'value', 'parameters', 'allowInProposals'] as const;
const MATCHER_FIELDS = ['origin', 'method', 'path', 'match'] as const;
const STUB_BODY_KINDS = ['fixture', 'json', 'text'] as const;

// ---- The sections ----------------------------------------------------------------------------

export function readStubDeclarations(input: unknown, context: NetworkDeclarationContext): Parsed<Readonly<Record<StubName, StubDeclaration>>> {
  return readDeclarationSection<'StubName', StubDeclaration>(
    input, '$.stubs', context.issues, MAXIMUM_DECLARATIONS, (declaration, path) => readStub(declaration, path, context),
  );
}

export function readObservedRequestDeclarations(
  input: unknown, context: NetworkDeclarationContext,
): Parsed<Readonly<Record<RequestName, ObservedRequestDeclaration>>> {
  return readDeclarationSection<'RequestName', ObservedRequestDeclaration>(
    input, '$.observedRequests', context.issues, MAXIMUM_DECLARATIONS, (declaration, path) => readObservedRequest(declaration, path, context),
  );
}

export function readStorageEntryDeclarations(
  input: unknown, context: NetworkDeclarationContext,
): Parsed<Readonly<Record<StorageEntryName, StorageEntryDeclaration>>> {
  return readDeclarationSection<'StorageEntryName', StorageEntryDeclaration>(
    input, '$.storageEntries', context.issues, MAXIMUM_DECLARATIONS, (declaration, path) => readStorageEntry(declaration, path, context),
  );
}

// ---- Shared parts ----------------------------------------------------------------------------

// allowInProposals defaults to false, so a plan with no approval gets a side effect only when the
// person says so.
function readAllowInProposals(fields: Readonly<Record<string, unknown>>, path: string, issues: Issues): Parsed<boolean> {
  const allow = fields['allowInProposals'] ?? false;
  if (typeof allow !== 'boolean') { issues.push({ code: 'wrong_type', path: `${path}.allowInProposals` }); return INVALID; }
  return allow;
}

// An origin the project allows, from `permitted`; any other well-formed origin is origin_not_allowed.
function readPermittedOrigin(input: unknown, path: string, issues: Issues, permitted: readonly Origin[]): Parsed<Origin> {
  const origin = readOrigin(input, path, issues);
  if (origin === INVALID) return INVALID;
  if (!permitted.includes(origin)) { issues.push({ code: 'origin_not_allowed', path }); return INVALID; }
  return origin;
}

function readMatcherPath(input: unknown, path: string, issues: Issues): Parsed<string> {
  const text = readText(input, path, issues, MAXIMUM_MATCHER_PATH_LENGTH);
  if (text === INVALID) return INVALID;
  if (!MATCHER_PATH.test(text)) { issues.push({ code: 'unknown_value', path }); return INVALID; }
  return text;
}

// The requests a stub answers or a check records. Its origin is an allowed origin or a declared
// service's: a matcher never names a place the project does not already reach.
function readMatcher(input: unknown, path: string, context: NetworkDeclarationContext): Parsed<RequestMatcher> {
  const { issues } = context;
  const fields = readRecord(input, path, issues, MATCHER_FIELDS);
  if (fields === INVALID) return INVALID;
  const parts = [
    readPermittedOrigin(fields['origin'], `${path}.origin`, issues, [...context.origins, ...context.serviceOrigins]),
    readOneOf(fields['method'], `${path}.method`, issues, HTTP_METHODS),
    readMatcherPath(fields['path'], `${path}.path`, issues),
    readOneOf(fields['match'], `${path}.match`, issues, PATH_MATCHES),
  ] as const;
  return allValid(parts) ? { origin: parts[0], method: parts[1], path: parts[2], match: parts[3] } : INVALID;
}

// ---- Stubs -----------------------------------------------------------------------------------

function readStub(input: unknown, path: string, context: NetworkDeclarationContext): Parsed<StubDeclaration> {
  const { issues } = context;
  const fields = readRecord(input, path, issues, STUB_FIELDS, ['request', 'parameters', 'responses']);
  if (fields === INVALID) return INVALID;
  const request = readMatcher(fields['request'], `${path}.request`, context);
  const allowInProposals = readAllowInProposals(fields, path, issues);
  // The bodies name parameters, so they are read only once the parameters are known.
  const parameters = readParameters(fields['parameters'], `${path}.parameters`, issues);
  if (parameters === INVALID) return INVALID;
  const responsesPath = `${path}.responses`;
  const rawResponses = readList(fields['responses'], responsesPath, issues, MAXIMUM_STUB_RESPONSES);
  if (rawResponses === INVALID) return INVALID;
  const responses = rawResponses.map((response, index) => readStubResponse(response, `${responsesPath}[${index}]`, context, parameters));
  if (request === INVALID || allowInProposals === INVALID || !allValid(responses)) return INVALID;
  return { request, parameters, responses, allowInProposals };
}

function readStubResponse(
  input: unknown, path: string, context: NetworkDeclarationContext, parameters: Readonly<Record<ParameterName, ParameterType>>,
): Parsed<StubResponse> {
  const { issues } = context;
  const fields = readRecord(input, path, issues, STUB_RESPONSE_FIELDS, ['status', 'mediaType', 'body']);
  if (fields === INVALID) return INVALID;
  const parts = [
    readInteger(fields['status'], `${path}.status`, issues, STUB_STATUS.lowest, STUB_STATUS.highest),
    readOneOf(fields['mediaType'], `${path}.mediaType`, issues, STUB_MEDIA_TYPES),
    readStubBody(fields['body'], `${path}.body`, context, parameters),
  ] as const;
  const headers = Object.hasOwn(fields, 'headers') ? readStubHeaders(fields['headers'], `${path}.headers`, issues) : undefined;
  if (!allValid(parts) || headers === INVALID) return INVALID;
  // Headers are left out when absent.
  return { status: parts[0], mediaType: parts[1], ...(headers === undefined ? {} : { headers }), body: parts[2] };
}

// Header values are safe text, which holds no line break, so no header can be smuggled in.
function readStubHeaders(input: unknown, path: string, issues: Issues): Parsed<Readonly<Record<string, SafeText>>> {
  const fields = peekRecord(input, path, issues);
  if (fields === INVALID) return INVALID;
  const seen = new Set<string>();
  const entries = Object.entries(fields).map(([name, value]): Parsed<readonly [string, SafeText]> => {
    const at = `${path}.${name}`;
    if (!HEADER_NAME.test(name)) { issues.push({ code: 'unknown_value', path: at }); return INVALID; }
    const lower = name.toLowerCase();
    if (DENIED_STUB_HEADERS.includes(lower) || DENIED_STUB_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      issues.push({ code: 'header_not_allowed', path: at });
      return INVALID;
    }
    // Header names are case-insensitive, so "Retry-After" and "retry-after" are one header set twice.
    if (seen.has(lower)) { issues.push({ code: 'duplicate', path: at }); return INVALID; }
    seen.add(lower);
    const text = readText(value, at, issues, MAXIMUM_HEADER_VALUE_LENGTH);
    return text === INVALID ? INVALID : [name, text];
  });
  return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

// null, or exactly one of { fixture }, { json } and { text }.
function readStubBody(
  input: unknown, path: string, context: NetworkDeclarationContext, parameters: Readonly<Record<ParameterName, ParameterType>>,
): Parsed<StubResponseBody> {
  const { issues } = context;
  if (input === null) return null;
  const head = peekRecord(input, path, issues);
  if (head === INVALID) return INVALID;
  const kind = STUB_BODY_KINDS.find((candidate) => Object.hasOwn(head, candidate));
  if (kind === undefined) {
    // No body kind at all: every key is one the format does not have, or there is none.
    if (readRecord(input, path, issues, STUB_BODY_KINDS, []) !== INVALID) issues.push({ code: 'empty', path });
    return INVALID;
  }
  if (readRecord(input, path, issues, [kind]) === INVALID) return INVALID;
  const at = `${path}.${kind}`;
  switch (kind) {
    case 'fixture': {
      const fixture = head['fixture'];
      if (typeof fixture !== 'string') { issues.push({ code: 'wrong_type', path: at }); return INVALID; }
      // Only a file the project declares, so a stub can never serve a file from outside the fixtures folder.
      const found = context.fixtures.find((name) => name === fixture);
      if (found === undefined) { issues.push({ code: 'unknown_value', path: at }); return INVALID; }
      return { fixture: found };
    }
    case 'json': {
      const json = readJsonTemplate(head['json'], at, issues, parameters);
      return json === INVALID ? INVALID : { json };
    }
    case 'text': {
      const text = readText(head['text'], at, issues, MAXIMUM_TEXT_BODY_LENGTH);
      return text === INVALID ? INVALID : { text };
    }
  }
}

// ---- Observed requests -------------------------------------------------------------------------

function readObservedRequest(input: unknown, path: string, context: NetworkDeclarationContext): Parsed<ObservedRequestDeclaration> {
  const { issues } = context;
  const fields = readRecord(input, path, issues, OBSERVED_REQUEST_FIELDS, ['request']);
  if (fields === INVALID) return INVALID;
  const request = readMatcher(fields['request'], `${path}.request`, context);
  const responseFields = Object.hasOwn(fields, 'fields') ? readFields(fields['fields'], `${path}.fields`, issues) : undefined;
  const maximumResponseBytes = Object.hasOwn(fields, 'maximumResponseBytes')
    ? readInteger(fields['maximumResponseBytes'], `${path}.maximumResponseBytes`, issues, 1, MAXIMUM_OBSERVED_RESPONSE_BYTES)
    : DEFAULT_OBSERVED_RESPONSE_BYTES;
  if (request === INVALID || responseFields === INVALID || maximumResponseBytes === INVALID) return INVALID;
  // Fields are left out when absent: the requests are then only counted.
  return { request, ...(responseFields === undefined ? {} : { fields: responseFields }), maximumResponseBytes };
}

// ---- Storage entries ---------------------------------------------------------------------------

// A read entry has no value and no parameters, since nothing is ever written to it; a readWrite
// entry needs a value.
function readStorageEntry(input: unknown, path: string, context: NetworkDeclarationContext): Parsed<StorageEntryDeclaration> {
  const { issues } = context;
  const fields = readRecord(input, path, issues, STORAGE_ENTRY_FIELDS, ['area', 'origin', 'key', 'access']);
  if (fields === INVALID) return INVALID;
  const parts = [
    readOneOf(fields['area'], `${path}.area`, issues, STORAGE_AREAS),
    readPermittedOrigin(fields['origin'], `${path}.origin`, issues, context.origins),
    readText(fields['key'], `${path}.key`, issues, MAXIMUM_STORAGE_KEY_LENGTH),
    readOneOf(fields['access'], `${path}.access`, issues, STORAGE_ACCESS),
    readAllowInProposals(fields, path, issues),
  ] as const;
  if (!allValid(parts)) return INVALID;
  const [area, origin, key, access, allowInProposals] = parts;
  if (access === 'read') {
    const written = ['value', 'parameters'].filter((field) => Object.hasOwn(fields, field));
    for (const field of written) issues.push({ code: 'unknown_field', path: `${path}.${field}` });
    return written.length > 0 ? INVALID : { area, origin, key, access, allowInProposals };
  }
  if (!Object.hasOwn(fields, 'value')) { issues.push({ code: 'missing_field', path: `${path}.value` }); return INVALID; }
  const parameters = Object.hasOwn(fields, 'parameters') ? readParameters(fields['parameters'], `${path}.parameters`, issues) : undefined;
  if (parameters === INVALID) return INVALID;
  const value: Parsed<JsonTemplate> = readJsonTemplate(fields['value'], `${path}.value`, issues, parameters ?? {});
  if (value === INVALID) return INVALID;
  // Parameters are left out when absent.
  return { area, origin, key, access, value, ...(parameters === undefined ? {} : { parameters }), allowInProposals };
}
