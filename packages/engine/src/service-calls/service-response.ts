// Reads a declared call's response: whether its status is one the declaration counts as success,
// its JSON body within the size cap, and a field by its JSON pointer. Nothing here keeps the body:
// a run records only its status and sha256 until redacted excerpts land (SPEC-09).
// See docs/specs/SPEC-32-declared-service-calls.md.
import {
  failure, success,
  type BackendAssertion, type CallDeclaration, type JsonPointer, type ResponseReadErrorCode, type Result, type SafeText, type ServiceResponse,
} from '@revisum/contracts';

// application/json, or a structured suffix such as application/problem+json.
const JSON_MEDIA_TYPE = /^application\/([A-Za-z0-9.!#$&^_-]+\+)?json\s*(;|$)/i;

// True when the status is one the declaration lists. A redirect is judged like any other status:
// the caller never follows one.
export const isSuccessStatus = (declaration: CallDeclaration, response: ServiceResponse): boolean =>
  declaration.successStatuses.includes(response.status);

// The body as JSON. The caller stops reading at the cap; a body over it is refused here as well.
export function responseJson(response: ServiceResponse, maximumResponseBytes: number): Result<unknown, ResponseReadErrorCode> {
  if (response.body.length > maximumResponseBytes) return failure('response-too-large');
  if (response.mediaType !== null && !JSON_MEDIA_TYPE.test(response.mediaType)) return failure('response-not-json');
  try {
    return success(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)));
  } catch {
    return failure('response-not-json');
  }
}

// The value a JSON pointer names (RFC 6901), or field-missing when it names nothing.
export function fieldAt(document: unknown, pointer: JsonPointer): Result<unknown, 'field-missing'> {
  if (pointer === '') return success(document);
  let current: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = /^(0|[1-9][0-9]*)$/.test(token) ? Number(token) : Number.NaN;
      if (!(index < current.length)) return failure('field-missing');
      current = current[index];
    } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, token)) {
      current = Object.entries(current).find(([key]) => key === token)?.[1];
    } else {
      return failure('field-missing');
    }
  }
  return success(current);
}

// A field's value as text, for a run value or a text check: a string as it is, a number or a
// boolean as JSON writes it. Null, objects and lists have no text.
export const fieldText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;

// Whether one field passes a backend check. `found` is the field, or undefined when its pointer
// names nothing; `expected` is the check's text with any value reference already resolved.
export function checkBackendField(assertion: BackendAssertion, found: { readonly value: unknown } | undefined, expected: SafeText | null): boolean {
  switch (assertion.kind) {
    case 'present': return found !== undefined;
    case 'absent': return found === undefined;
    case 'numberEquals': return typeof found?.value === 'number' && found.value === assertion.value;
    case 'equals': case 'contains': {
      const text = found === undefined ? undefined : fieldText(found.value);
      if (text === undefined || expected === null) return false;
      // Backend data is not rendered text, so it is compared exactly, spaces and case included.
      return assertion.kind === 'equals' ? text === expected : text.includes(expected);
    }
  }
}
