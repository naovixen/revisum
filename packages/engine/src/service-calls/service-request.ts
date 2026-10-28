// Builds the one request a call declaration allows, from the plan's arguments, the run's values and
// its secrets. It is pure: no I/O. Origin, method and header names come only from the declaration.
// A parameter fills a whole path segment or query value, percent-encoded as one, or a whole JSON
// value; it is written inside a string only for types that cannot hold quotes, spaces or
// separators. Text is never spliced into the request, so no argument can change its shape.
// See docs/specs/SPEC-32-declared-service-calls.md.
import {
  failure, isSecret, success,
  type CallArgument, type CallArguments, type CallDeclaration, type JsonTemplate, type Origin, type ParameterType, type Result,
  type JsonBodyWithSecrets, type Secret, type SecretStore, type ServiceRequest, type ServiceRequestHeader,
} from '@revisum/contracts';
import { resolveText, type RunValues } from '../run-values.ts';
import { headerSecret } from '../secrets/secret-values.ts';
import { argumentProblem, argumentText, runValueArgument, type ArgumentValue } from './parameter-values.ts';

export type RequestBuildError = 'parameter-invalid' | 'secret-missing';

// What a declaration that sets no limits of its own gets: 10 s and 1 MiB.
export const DEFAULT_CALL_TIMEOUT_MILLISECONDS = 10_000;
export const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;

// A "{name}" placeholder in a path segment or an interpolated string.
const PLACEHOLDER = /\{([^{}]*)\}/g;
const WHOLE_SEGMENT_PLACEHOLDER = /^\{([^{}]*)\}$/;
const JSON_MEDIA_TYPE = 'application/json';

// A parameter once its argument is known: a value of its type, or a resolved secret.
type Filled = { readonly kind: 'value'; readonly value: ArgumentValue } | { readonly kind: 'secret'; readonly secret: Secret };
type Built<Value> = Result<Value, RequestBuildError>;
// A JSON value whose leaves may be secrets, as a body is once its parameters fill it.
type JsonWithSecrets = null | boolean | number | string | Secret | readonly JsonWithSecrets[] | { readonly [key: string]: JsonWithSecrets };

// Appends the JSON text of `value` to `parts`, structurally, with each secret left as an opaque
// part that runner's caller writes as one JSON string. Text parts are written as JSON.stringify
// writes them, so a body with no secret is exactly its JSON text.
function writeJson(value: JsonWithSecrets, parts: (string | Secret)[]): void {
  if (isSecret(value)) { parts.push(value); return; }
  if (Array.isArray(value)) {
    parts.push('[');
    value.forEach((item, index) => { if (index > 0) parts.push(','); writeJson(item, parts); });
    parts.push(']');
    return;
  }
  if (typeof value === 'object' && value !== null) {
    parts.push('{');
    Object.entries(value).forEach(([key, entry], index) => { parts.push(`${index > 0 ? ',' : ''}${JSON.stringify(key)}:`); writeJson(entry, parts); });
    parts.push('}');
    return;
  }
  parts.push(JSON.stringify(value));
}

// The body in parts, adjacent text parts joined, so a body with no secret is one text part.
function bodyOf(value: JsonWithSecrets): JsonBodyWithSecrets {
  const written: (string | Secret)[] = [];
  writeJson(value, written);
  const jsonParts: (string | Secret)[] = [];
  for (const part of written) {
    const last = jsonParts.at(-1);
    if (typeof part === 'string' && typeof last === 'string') jsonParts[jsonParts.length - 1] = last + part;
    else jsonParts.push(part);
  }
  return { jsonParts };
}

// One argument, checked against its parameter's type. A literal was checked by the plan parser
// already and is checked again here; a run value is checked now that its text is known.
function fill(type: ParameterType, argument: CallArgument | undefined, values: RunValues, secrets: SecretStore): Built<Filled> {
  if (argument === undefined) return failure('parameter-invalid');
  if (typeof argument === 'object' && 'secretName' in argument) {
    if (type.kind !== 'secret') return failure('parameter-invalid');
    const secret = secrets.resolve(argument.secretName);
    return secret === null ? failure('secret-missing') : success({ kind: 'secret', secret });
  }
  if (type.kind === 'secret') return failure('parameter-invalid');
  if (typeof argument === 'object') {
    // The parameter's type holds the value to its own length, so no other limit applies here.
    const text = resolveText(argument, values, Number.POSITIVE_INFINITY);
    const value = text.ok ? runValueArgument(type, text.value) : undefined;
    return value === undefined ? failure('parameter-invalid') : success({ kind: 'value', value });
  }
  return argumentProblem(type, argument) === undefined ? success({ kind: 'value', value: argument }) : failure('parameter-invalid');
}

// A parameter's value as text for a URL or a string. A secret never goes there; the project
// parser refuses a declaration that would put one there.
function textOf(filled: ReadonlyMap<string, Filled>, name: string): Built<string> {
  const parameter = filled.get(name);
  return parameter?.kind === 'value' ? success(argumentText(parameter.value)) : failure('parameter-invalid');
}

// Percent-encoded as one whole component, so "/", "?", "#", "&" and "%" stay inside it. Text that
// cannot be encoded, such as a lone surrogate, is refused.
function encodeComponent(text: string): Built<string> {
  try { return success(encodeURIComponent(text)); } catch { return failure('parameter-invalid'); }
}

// The path, each placeholder filling a whole segment. A filled segment of "", "." or ".." would
// drop or climb a segment, so it is refused.
function buildPath(path: string, filled: ReadonlyMap<string, Filled>): Built<string> {
  const segments: string[] = [];
  for (const segment of path.slice(1).split('/')) {
    const placeholder = WHOLE_SEGMENT_PLACEHOLDER.exec(segment);
    if (placeholder === null) { segments.push(segment); continue; }
    const text = textOf(filled, placeholder[1] ?? '');
    if (!text.ok) return text;
    if (text.value === '' || text.value === '.' || text.value === '..') return failure('parameter-invalid');
    const encoded = encodeComponent(text.value);
    if (!encoded.ok) return encoded;
    segments.push(encoded.value);
  }
  return success(`/${segments.join('/')}`);
}

// A template with its parameters in place. An interpolated string takes the parameters' text;
// everything else is built as a JSON structure, never as text.
function fillTemplate(template: JsonTemplate, filled: ReadonlyMap<string, Filled>): Built<JsonWithSecrets> {
  if (template === null || typeof template !== 'object') return success(template);
  if (Array.isArray(template)) {
    const items: JsonWithSecrets[] = [];
    for (const item of template) {
      const built = fillTemplate(item, filled);
      if (!built.ok) return built;
      items.push(built.value);
    }
    return success(items);
  }
  // The project parser refused every other key starting with "$", so these two are placeholders.
  if ('$parameter' in template && typeof template.$parameter === 'string') {
    const parameter = filled.get(template.$parameter);
    if (parameter === undefined) return failure('parameter-invalid');
    return success(parameter.kind === 'secret' ? parameter.secret : parameter.value);
  }
  if ('$interpolate' in template && typeof template.$interpolate === 'string') {
    let problem: RequestBuildError | undefined;
    const text = template.$interpolate.replace(PLACEHOLDER, (_placeholder, name: string) => {
      const value = textOf(filled, name);
      if (!value.ok) problem = value.error;
      return value.ok ? value.value : '';
    });
    return problem === undefined ? success(text) : failure(problem);
  }
  const entries: [string, JsonWithSecrets][] = [];
  for (const [key, value] of Object.entries(template)) {
    const built = fillTemplate(value, filled);
    if (!built.ok) return built;
    entries.push([key, built.value]);
  }
  return success(Object.fromEntries(entries));
}

// "?key=value&…" in the declaration's order, or "" for no query. Each value is a scalar.
function buildQuery(query: Readonly<Record<string, JsonTemplate>>, filled: ReadonlyMap<string, Filled>): Built<string> {
  const pairs: string[] = [];
  for (const [key, template] of Object.entries(query)) {
    const built = fillTemplate(template, filled);
    if (!built.ok) return built;
    const value = built.value;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return failure('parameter-invalid');
    const encoded = encodeComponent(String(value));
    if (!encoded.ok) return encoded;
    pairs.push(`${encodeURIComponent(key)}=${encoded.value}`);
  }
  return success(pairs.length === 0 ? '' : `?${pairs.join('&')}`);
}

// The declared headers, a secret's value inside an opaque Secret, and a JSON content type for a
// body when the declaration does not set one.
function buildHeaders(declaration: CallDeclaration, secrets: SecretStore): Built<readonly ServiceRequestHeader[]> {
  const headers: ServiceRequestHeader[] = [];
  for (const [name, header] of Object.entries(declaration.headers ?? {})) {
    if ('literal' in header) { headers.push({ name, value: header.literal }); continue; }
    const secret = secrets.resolve(header.secretName);
    if (secret === null) return failure('secret-missing');
    headers.push({ name, value: headerSecret(secret, header.scheme) });
  }
  if (declaration.body !== undefined && !headers.some((header) => header.name.toLowerCase() === 'content-type')) {
    headers.push({ name: 'content-type', value: JSON_MEDIA_TYPE });
  }
  return success(headers);
}

// Pure. The request for one call: refused with parameter-invalid when an argument does not fit its
// parameter, and with secret-missing when the store lacks a secret the call needs.
export function buildServiceRequest(
  declaration: CallDeclaration, service: { readonly origin: Origin }, callArguments: CallArguments, values: RunValues, secrets: SecretStore,
): Result<ServiceRequest, RequestBuildError> {
  const given = new Map<string, CallArgument>(Object.entries(callArguments));
  const filled = new Map<string, Filled>();
  for (const [name, type] of Object.entries(declaration.parameters)) {
    const parameter = fill(type, given.get(name), values, secrets);
    if (!parameter.ok) return parameter;
    filled.set(name, parameter.value);
  }
  const headers = buildHeaders(declaration, secrets);
  if (!headers.ok) return headers;
  const path = buildPath(declaration.path, filled);
  if (!path.ok) return path;
  const query = buildQuery(declaration.query ?? {}, filled);
  if (!query.ok) return query;
  const body = declaration.body === undefined ? success(null) : fillTemplate(declaration.body, filled);
  if (!body.ok) return body;
  return success({
    origin: service.origin, method: declaration.method, pathAndQuery: `${path.value}${query.value}`, headers: headers.value,
    body: declaration.body === undefined ? null : bodyOf(body.value),
    timeoutMilliseconds: declaration.timeoutMilliseconds ?? DEFAULT_CALL_TIMEOUT_MILLISECONDS,
    maximumResponseBytes: declaration.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES,
  });
}
