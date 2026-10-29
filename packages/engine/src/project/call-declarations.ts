// Reads the trusted project's declared services and calls. A person declares each call: its
// service, method, path, query, headers and JSON body as templates, its typed parameters, its
// effect, the statuses that count as success and the response fields a plan may read. The parser
// refuses a declaration that could reach an undeclared service, splice text into a string, set a
// header that changes where or how a request travels, or read a field by a broken pointer, so
// every declaration it accepts builds requests of one fixed shape.
// See docs/specs/SPEC-32-declared-service-calls.md.
import {
  CALL_EFFECTS, HEADER_SCHEMES, HTTP_METHODS, PARAMETER_KINDS,
  type Brand, type CallDeclaration, type CallName, type DeclaredService, type FieldName, type HeaderValue, type JsonPointer, type JsonTemplate,
  type ParameterName, type ParameterType, type SafeText, type SecretName, type ServiceName,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import {
  INVALID, allValid, peekRecord, readInteger, readList, readOneOf, readRecord, readText, type Issues, type Parsed,
} from '../plan/plan-decoders.ts';
import { DECLARED_NAME, QUERY_KEY } from '../plan/plan-grammar.ts';
import { isInterpolationSafe } from '../service-calls/parameter-values.ts';
import { readOrigin } from './project-parser.ts';

// A service's name: a lowercase letter, then up to 39 lowercase letters, digits or hyphens.
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
// An HTTP header name: the characters RFC 9110 allows in a token.
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
// Headers that decide where or how a request travels, or carry the browser's session. A
// declaration may never set them; any header starting with "proxy-" neither.
const FORBIDDEN_HEADERS: readonly string[] = ['host', 'cookie', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer'];
const FORBIDDEN_HEADER_PREFIX = 'proxy-';
// RFC 6901: "", or "/"-separated tokens in which "~" is always followed by 0 or 1.
const JSON_POINTER = /^(\/([^~]|~[01])*)*$/;
// A whole-segment placeholder in a path, such as "{orderId}".
const PATH_PLACEHOLDER = /^\{([^{}]*)\}$/;
// A literal path segment: unreserved and sub-delimiter characters, or percent escapes.
const LITERAL_SEGMENT = /^([A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+$/;
// A "{name}" placeholder inside an interpolated string.
const STRING_PLACEHOLDER = /\{([^{}]*)\}/g;

const MAXIMUM_SERVICES = 64;
const LARGEST_PORT = 65_535;
const MAXIMUM_CALLS = 256;
const MAXIMUM_PARAMETERS = 64;
const MAXIMUM_ONE_OF_VALUES = 256;
const MAXIMUM_TEMPLATE_DEPTH = 32;
const MAXIMUM_PATH_LENGTH = 2048;
const MAXIMUM_HEADER_LITERAL_LENGTH = 1024;
const MAXIMUM_TEXT_PARAMETER_LENGTH = 4000;
const MAXIMUM_SUCCESS_STATUSES = 32;
const MAXIMUM_CALL_TIMEOUT_MILLISECONDS = 120_000;
const MAXIMUM_RESPONSE_BYTES = 16 * 1024 * 1024;

const DECLARATION_FIELDS = [
  'service', 'method', 'path', 'query', 'headers', 'body', 'parameters', 'effect', 'successStatuses', 'fields', 'allowInProposals',
  'timeoutMilliseconds', 'maximumResponseBytes',
] as const;
const REQUIRED_DECLARATION_FIELDS = ['service', 'method', 'path', 'parameters', 'effect', 'successStatuses'] as const;

const isPlainObject = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

// ---- Services ---------------------------------------------------------------------------------

// An optional list of services, each { name, origin, private, port }. Absent means none; `private`
// defaults to false, so a service may reach a private address only when the person says so. The
// port, the one a database command may reach, is left out when absent.
export function readServices(input: unknown, issues: Issues): Parsed<readonly DeclaredService[]> {
  if (input === undefined) return [];
  const raw = readList(input, '$.services', issues, MAXIMUM_SERVICES, 0);
  if (raw === INVALID) return INVALID;
  const services = raw.map((entry, index): Parsed<DeclaredService> => {
    const path = `$.services[${index}]`;
    const fields = readRecord(entry, path, issues, ['name', 'origin', 'private', 'port'], ['name', 'origin']);
    if (fields === INVALID) return INVALID;
    const name = fields['name'];
    const readName = (): Parsed<ServiceName> => {
      if (typeof name !== 'string') { issues.push({ code: 'wrong_type', path: `${path}.name` }); return INVALID; }
      if (!SERVICE_NAME.test(name)) { issues.push({ code: 'unknown_value', path: `${path}.name` }); return INVALID; }
      return brand<string, 'ServiceName'>(name);
    };
    const isPrivate = fields['private'] ?? false;
    if (typeof isPrivate !== 'boolean') issues.push({ code: 'wrong_type', path: `${path}.private` });
    const port = Object.hasOwn(fields, 'port') ? readInteger(fields['port'], `${path}.port`, issues, 1, LARGEST_PORT) : undefined;
    const parts = [readName(), readOrigin(fields['origin'], `${path}.origin`, issues), typeof isPrivate === 'boolean' ? isPrivate : INVALID] as const;
    if (!allValid(parts) || port === INVALID) return INVALID;
    return { name: parts[0], origin: parts[1], private: parts[2], ...(port === undefined ? {} : { port }) };
  });
  if (!allValid(services)) return INVALID;
  if (new Set(services.map((service) => service.name)).size !== services.length) {
    issues.push({ code: 'duplicate', path: '$.services' });
    return INVALID;
  }
  return services;
}

// ---- Calls ------------------------------------------------------------------------------------

// What a declaration may refer to: the project's services and secret names.
export type DeclarationContext = {
  readonly issues: Issues;
  readonly services: readonly DeclaredService[];
  readonly secretNames: readonly SecretName[];
};

// What a declared name must be: it matches `pattern` and, when given, passes `allowed`.
export type DeclaredNameRule = { readonly pattern: RegExp; readonly allowed?: (name: string) => boolean };
const DECLARED_NAME_RULE: DeclaredNameRule = { pattern: DECLARED_NAME };

// A project section of named declarations, such as `calls`, `stubs` or a suite's `environment`,
// read the same way for every kind: absent means none, each name follows the section's name rule
// (the declared-name pattern unless another is given), and a name outside it is refused alone, as
// unknown_value at the name, with nothing under it read.
export function readDeclarationSection<Name extends string, Declaration>(
  input: unknown, path: string, issues: Issues, maximumCount: number, read: (input: unknown, path: string) => Parsed<Declaration>,
  rule: DeclaredNameRule = DECLARED_NAME_RULE,
): Parsed<Readonly<Record<Brand<string, Name>, Declaration>>> {
  if (input === undefined) return {};
  const fields = peekRecord(input, path, issues);
  if (fields === INVALID) return INVALID;
  const names = Object.keys(fields);
  if (names.length > maximumCount) { issues.push({ code: 'too_large', path }); return INVALID; }
  const entries = names.map((name): Parsed<readonly [Brand<string, Name>, Declaration]> => {
    const at = `${path}.${name}`;
    const declaredName = readName<Name>(name, at, issues, rule);
    if (declaredName === INVALID) return INVALID;
    const declaration = read(fields[name], at);
    return declaration === INVALID ? INVALID : [declaredName, declaration];
  });
  if (!allValid(entries)) return INVALID;
  return Object.fromEntries(entries);
}

// The calls a project declares, by name. Absent means none.
export function readCallDeclarations(input: unknown, context: DeclarationContext): Parsed<Readonly<Record<CallName, CallDeclaration>>> {
  return readDeclarationSection<'CallName', CallDeclaration>(
    input, '$.calls', context.issues, MAXIMUM_CALLS, (declaration, path) => readDeclaration(declaration, path, context),
  );
}

function readDeclaration(input: unknown, path: string, context: DeclarationContext): Parsed<CallDeclaration> {
  const { issues } = context;
  const fields = readRecord(input, path, issues, DECLARATION_FIELDS, REQUIRED_DECLARATION_FIELDS);
  if (fields === INVALID) return INVALID;
  const service = readServiceName(fields['service'], `${path}.service`, context);
  const method = readOneOf(fields['method'], `${path}.method`, issues, HTTP_METHODS);
  const effect = readOneOf(fields['effect'], `${path}.effect`, issues, CALL_EFFECTS);
  const successStatuses = readSuccessStatuses(fields['successStatuses'], `${path}.successStatuses`, issues);
  const responseFields = Object.hasOwn(fields, 'fields') ? readFields(fields['fields'], `${path}.fields`, issues) : undefined;
  const allowInProposals = fields['allowInProposals'] ?? false;
  if (typeof allowInProposals !== 'boolean') issues.push({ code: 'wrong_type', path: `${path}.allowInProposals` });
  const timeoutMilliseconds = Object.hasOwn(fields, 'timeoutMilliseconds')
    ? readInteger(fields['timeoutMilliseconds'], `${path}.timeoutMilliseconds`, issues, 1, MAXIMUM_CALL_TIMEOUT_MILLISECONDS) : undefined;
  const maximumResponseBytes = Object.hasOwn(fields, 'maximumResponseBytes')
    ? readInteger(fields['maximumResponseBytes'], `${path}.maximumResponseBytes`, issues, 1, MAXIMUM_RESPONSE_BYTES) : undefined;
  const headers = Object.hasOwn(fields, 'headers') ? readHeaders(fields['headers'], `${path}.headers`, context) : undefined;
  // The templates name parameters, so they are read only once the parameters are known.
  const parameters = readParameters(fields['parameters'], `${path}.parameters`, issues);
  if (parameters === INVALID) return INVALID;
  const templates: TemplateContext = { issues, parameters };
  const requestPath = readRequestPath(fields['path'], `${path}.path`, templates);
  const query = Object.hasOwn(fields, 'query') ? readQuery(fields['query'], `${path}.query`, templates) : undefined;
  const body = Object.hasOwn(fields, 'body') ? readTemplate(fields['body'], `${path}.body`, templates, 'body', 0) : undefined;
  const parts = [service, method, effect, successStatuses, requestPath] as const;
  if (!allValid(parts) || typeof allowInProposals !== 'boolean' || responseFields === INVALID || timeoutMilliseconds === INVALID
    || maximumResponseBytes === INVALID || headers === INVALID || query === INVALID || body === INVALID) return INVALID;
  // Optional parts are left out when absent.
  return {
    service: parts[0], method: parts[1], path: parts[4],
    ...(query === undefined ? {} : { query }),
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
    parameters, effect: parts[2], successStatuses: parts[3],
    ...(responseFields === undefined ? {} : { fields: responseFields }),
    allowInProposals,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
    ...(maximumResponseBytes === undefined ? {} : { maximumResponseBytes }),
  };
}

function readServiceName(input: unknown, path: string, context: DeclarationContext): Parsed<ServiceName> {
  if (typeof input !== 'string') { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  const found = context.services.find((service) => service.name === input);
  if (found === undefined) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return found.name;
}

// A name that follows `rule` (by default the declared-name pattern), branded as `Name` once checked.
function readName<Name extends string>(
  name: string, path: string, issues: Issues, rule: DeclaredNameRule = DECLARED_NAME_RULE,
): Parsed<Brand<string, Name>> {
  if (!rule.pattern.test(name) || rule.allowed?.(name) === false) { issues.push({ code: 'unknown_value', path }); return INVALID; }
  return brand<string, Name>(name);
}

function readSuccessStatuses(input: unknown, path: string, issues: Issues): Parsed<readonly number[]> {
  const raw = readList(input, path, issues, MAXIMUM_SUCCESS_STATUSES);
  if (raw === INVALID) return INVALID;
  const statuses = raw.map((status, index) => readInteger(status, `${path}[${index}]`, issues, 100, 599));
  if (!allValid(statuses)) return INVALID;
  if (new Set(statuses).size !== statuses.length) { issues.push({ code: 'duplicate', path }); return INVALID; }
  return statuses;
}

export function readFields(input: unknown, path: string, issues: Issues): Parsed<Readonly<Record<FieldName, JsonPointer>>> {
  const fields = peekRecord(input, path, issues);
  if (fields === INVALID) return INVALID;
  const entries = Object.entries(fields).map(([key, pointer]): Parsed<readonly [FieldName, JsonPointer]> => {
    const at = `${path}.${key}`;
    const name = readName<'FieldName'>(key, at, issues);
    if (name === INVALID) return INVALID;
    if (typeof pointer !== 'string') { issues.push({ code: 'wrong_type', path: at }); return INVALID; }
    if (!JSON_POINTER.test(pointer)) { issues.push({ code: 'unknown_value', path: at }); return INVALID; }
    return [name, brand<string, 'JsonPointer'>(pointer)];
  });
  return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

function readHeaders(input: unknown, path: string, context: DeclarationContext): Parsed<Readonly<Record<string, HeaderValue>>> {
  const { issues } = context;
  const fields = peekRecord(input, path, issues);
  if (fields === INVALID) return INVALID;
  const seen = new Set<string>();
  const entries = Object.entries(fields).map(([name, value]): Parsed<readonly [string, HeaderValue]> => {
    const at = `${path}.${name}`;
    if (!HEADER_NAME.test(name)) { issues.push({ code: 'unknown_value', path: at }); return INVALID; }
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.includes(lower) || lower.startsWith(FORBIDDEN_HEADER_PREFIX)) {
      issues.push({ code: 'header_not_allowed', path: at });
      return INVALID;
    }
    // Header names are case-insensitive, so "Accept" and "accept" are one header set twice.
    if (seen.has(lower)) { issues.push({ code: 'duplicate', path: at }); return INVALID; }
    seen.add(lower);
    const header = readHeaderValue(value, at, context);
    return header === INVALID ? INVALID : [name, header];
  });
  return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

// A literal value, which safe text keeps free of line breaks, so no header can be smuggled in; or a
// secret the project declares, by name, with the scheme that turns it into the header value.
function readHeaderValue(input: unknown, path: string, context: DeclarationContext): Parsed<HeaderValue> {
  const { issues } = context;
  if (isPlainObject(input) && Object.hasOwn(input, 'literal')) {
    const fields = readRecord(input, path, issues, ['literal']);
    if (fields === INVALID) return INVALID;
    const literal = readText(fields['literal'], `${path}.literal`, issues, MAXIMUM_HEADER_LITERAL_LENGTH);
    return literal === INVALID ? INVALID : { literal };
  }
  const fields = readRecord(input, path, issues, ['secretName', 'scheme']);
  if (fields === INVALID) return INVALID;
  const secretName = fields['secretName'];
  const readSecret = (): Parsed<SecretName> => {
    const at = `${path}.secretName`;
    if (typeof secretName !== 'string') { issues.push({ code: 'wrong_type', path: at }); return INVALID; }
    const found = context.secretNames.find((name) => name === secretName);
    if (found === undefined) { issues.push({ code: 'unknown_value', path: at }); return INVALID; }
    return found;
  };
  const parts = [readSecret(), readOneOf(fields['scheme'], `${path}.scheme`, issues, HEADER_SCHEMES)] as const;
  return allValid(parts) ? { secretName: parts[0], scheme: parts[1] } : INVALID;
}

// ---- Parameters -------------------------------------------------------------------------------

export function readParameters(input: unknown, path: string, issues: Issues): Parsed<Readonly<Record<ParameterName, ParameterType>>> {
  const fields = peekRecord(input, path, issues);
  if (fields === INVALID) return INVALID;
  if (Object.keys(fields).length > MAXIMUM_PARAMETERS) { issues.push({ code: 'too_large', path }); return INVALID; }
  const entries = Object.entries(fields).map(([key, type]): Parsed<readonly [ParameterName, ParameterType]> => {
    const at = `${path}.${key}`;
    const name = readName<'ParameterName'>(key, at, issues);
    const parameterType = name === INVALID ? INVALID : readParameterType(type, at, issues);
    return name === INVALID || parameterType === INVALID ? INVALID : [name, parameterType];
  });
  return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

function readParameterType(input: unknown, path: string, issues: Issues): Parsed<ParameterType> {
  const head = peekRecord(input, path, issues);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, issues, PARAMETER_KINDS);
  if (kind === INVALID) return INVALID;
  switch (kind) {
    case 'text': {
      if (readRecord(input, path, issues, ['kind', 'maximumLength']) === INVALID) return INVALID;
      const maximumLength = readInteger(head['maximumLength'], `${path}.maximumLength`, issues, 1, MAXIMUM_TEXT_PARAMETER_LENGTH);
      return maximumLength === INVALID ? INVALID : { kind, maximumLength };
    }
    case 'integer': {
      if (readRecord(input, path, issues, ['kind', 'minimum', 'maximum']) === INVALID) return INVALID;
      const minimum = readInteger(head['minimum'], `${path}.minimum`, issues, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      const maximum = readInteger(head['maximum'], `${path}.maximum`, issues, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      if (minimum === INVALID || maximum === INVALID) return INVALID;
      if (maximum < minimum) { issues.push({ code: 'unknown_value', path: `${path}.maximum` }); return INVALID; }
      return { kind, minimum, maximum };
    }
    case 'oneOf': {
      if (readRecord(input, path, issues, ['kind', 'values']) === INVALID) return INVALID;
      const raw = readList(head['values'], `${path}.values`, issues, MAXIMUM_ONE_OF_VALUES);
      if (raw === INVALID) return INVALID;
      const values = raw.map((value, index): Parsed<SafeText> => readText(value, `${path}.values[${index}]`, issues, MAXIMUM_TEXT_PARAMETER_LENGTH));
      if (!allValid(values)) return INVALID;
      if (new Set(values).size !== values.length) { issues.push({ code: 'duplicate', path: `${path}.values` }); return INVALID; }
      return { kind, values };
    }
    case 'identifier': case 'boolean': case 'email': case 'yearMonthDay': case 'secret':
      return readRecord(input, path, issues, ['kind']) === INVALID ? INVALID : { kind };
  }
}

// ---- Templates --------------------------------------------------------------------------------

type TemplateContext = { readonly issues: Issues; readonly parameters: Readonly<Record<ParameterName, ParameterType>> };

// The declared parameter named `input`, or undefined.
function declaredParameter(input: unknown, context: TemplateContext): readonly [ParameterName, ParameterType] | undefined {
  const found = Object.entries(context.parameters).find(([name]) => name === input);
  return found === undefined ? undefined : [brand<string, 'ParameterName'>(found[0]), found[1]];
}

// The request path: literal segments and "{name}" placeholders that each fill a whole segment. A
// segment is never empty, except a final one for a trailing "/", so the path cannot start with
// "//" and be read as another host. A secret never goes into a URL.
function readRequestPath(input: unknown, path: string, context: TemplateContext): Parsed<string> {
  const { issues } = context;
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (input.length > MAXIMUM_PATH_LENGTH || !input.startsWith('/')) { issues.push({ code: 'unknown_value', path }); return INVALID; }
  const segments = input.slice(1).split('/');
  for (const [index, segment] of segments.entries()) {
    const placeholder = PATH_PLACEHOLDER.exec(segment);
    if (placeholder !== null) {
      const parameter = declaredParameter(placeholder[1], context);
      if (parameter === undefined) { issues.push({ code: 'unknown_value', path }); return INVALID; }
      if (parameter[1].kind === 'secret') { issues.push({ code: 'unsafe_interpolation', path }); return INVALID; }
      continue;
    }
    const lastAndEmpty = segment === '' && index === segments.length - 1;
    if (!lastAndEmpty && (!LITERAL_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
      issues.push({ code: 'unknown_value', path });
      return INVALID;
    }
  }
  return input;
}

// Query values, each a template whose result is a scalar.
function readQuery(input: unknown, path: string, context: TemplateContext): Parsed<Readonly<Record<string, JsonTemplate>>> {
  const fields = peekRecord(input, path, context.issues);
  if (fields === INVALID) return INVALID;
  const entries = Object.entries(fields).map(([key, value]): Parsed<readonly [string, JsonTemplate]> => {
    const at = `${path}.${key}`;
    if (!QUERY_KEY.test(key)) { context.issues.push({ code: 'unknown_value', path: at }); return INVALID; }
    const template = readTemplate(value, at, context, 'query', 0);
    return template === INVALID ? INVALID : [key, template];
  });
  return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

// A whole JSON value as a template whose placeholders name `parameters`, such as a stub's JSON body
// or a storage entry's value, read under the same rules as a call's body.
export const readJsonTemplate = (
  input: unknown, path: string, issues: Issues, parameters: Readonly<Record<ParameterName, ParameterType>>,
): Parsed<JsonTemplate> => readTemplate(input, path, { issues, parameters }, 'body', 0);

// A JSON template. In a query only scalars, placeholders and interpolated strings are allowed. A
// literal object key starting with "$" is refused, so no operator key such as "$where" can pass
// for a placeholder or reach the service unseen.
function readTemplate(input: unknown, path: string, context: TemplateContext, where: 'body' | 'query', depth: number): Parsed<JsonTemplate> {
  const { issues } = context;
  if (depth > MAXIMUM_TEMPLATE_DEPTH) { issues.push({ code: 'too_large', path }); return INVALID; }
  if (typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) { issues.push({ code: 'wrong_type', path }); return INVALID; }
    return input;
  }
  if (input === null || Array.isArray(input)) {
    if (where === 'query') { issues.push({ code: 'wrong_type', path }); return INVALID; }
    if (input === null) return null;
    const items = input.map((item, index) => readTemplate(item, `${path}[${index}]`, context, where, depth + 1));
    return allValid(items) ? items : INVALID;
  }
  if (!isPlainObject(input)) { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (Object.hasOwn(input, '$parameter')) return readParameterPlaceholder(input, path, context, where);
  if (Object.hasOwn(input, '$interpolate')) return readInterpolatedString(input, path, context);
  if (where === 'query') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  const entries = Object.entries(input).map(([key, value]): Parsed<readonly [string, JsonTemplate]> => {
    const at = `${path}.${key}`;
    if (key.startsWith('$')) { issues.push({ code: 'unknown_value', path: at }); return INVALID; }
    const template = readTemplate(value, at, context, where, depth + 1);
    return template === INVALID ? INVALID : [key, template];
  });
  return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

// { "$parameter": name }: the parameter fills a whole JSON value. A secret may fill a body value,
// never a query value, which would put it in the URL.
function readParameterPlaceholder(
  input: Readonly<Record<string, unknown>>, path: string, context: TemplateContext, where: 'body' | 'query',
): Parsed<JsonTemplate> {
  if (readRecord(input, path, context.issues, ['$parameter']) === INVALID) return INVALID;
  const parameter = declaredParameter(input['$parameter'], context);
  if (parameter === undefined) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  if (where === 'query' && parameter[1].kind === 'secret') { context.issues.push({ code: 'unsafe_interpolation', path }); return INVALID; }
  return { $parameter: parameter[0] };
}

// { "$interpolate": "…{name}…", "parameters": [name, …] }: parameters written into a string.
// Only types that cannot hold quotes, spaces or separators may be, and every placeholder in the
// string must be one of the listed parameters.
function readInterpolatedString(input: Readonly<Record<string, unknown>>, path: string, context: TemplateContext): Parsed<JsonTemplate> {
  const { issues } = context;
  const fields = readRecord(input, path, issues, ['$interpolate', 'parameters']);
  if (fields === INVALID) return INVALID;
  const template = fields['$interpolate'];
  if (typeof template !== 'string') { issues.push({ code: 'wrong_type', path: `${path}.$interpolate` }); return INVALID; }
  const raw = readList(fields['parameters'], `${path}.parameters`, issues, MAXIMUM_PARAMETERS);
  if (raw === INVALID) return INVALID;
  const parameters = raw.map((name, index): Parsed<ParameterName> => {
    const parameter = declaredParameter(name, context);
    if (parameter === undefined) { issues.push({ code: 'unknown_value', path: `${path}.parameters[${index}]` }); return INVALID; }
    if (!isInterpolationSafe(parameter[1])) { issues.push({ code: 'unsafe_interpolation', path }); return INVALID; }
    return parameter[0];
  });
  if (!allValid(parameters)) return INVALID;
  if (new Set(parameters).size !== parameters.length) { issues.push({ code: 'duplicate', path: `${path}.parameters` }); return INVALID; }
  const placeholders = [...template.matchAll(STRING_PLACEHOLDER)].map((match) => match[1] ?? '');
  if (placeholders.some((name) => !parameters.some((parameter) => parameter === name))) {
    issues.push({ code: 'unknown_value', path: `${path}.$interpolate` });
    return INVALID;
  }
  return { $interpolate: template, parameters };
}
