// Secrets: a plan names a secret; it never holds one. The value is resolved from the secret store
// when a run starts, travels inside an opaque Secret, and is read back only through reveal().
// Printing, serialising or inspecting a Secret gives "[secret]", so a value cannot slip into a
// result, a log or an error by accident.
//
// reveal() is exported here so the drivers can type a secret without importing the engine, but
// only the modules on the reveal allow-list may import it: REVEAL_ALLOWED_MODULES in
// tools/check-secret-reveal.ts, which `npm run lint` runs.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import type { SecretName } from './plan.ts';

// Below this length a value is too short to search for in outputs without matching ordinary text,
// so it is redacted by key (the field that holds it is never kept) rather than by value.
export const MINIMUM_SECRET_LENGTH = 8;
export type RedactionMode = 'value' | 'key-only';

export interface Secret {
  readonly name: SecretName;
}

// Where secrets come from. resolve() gives null for a name it does not hold.
export interface SecretStore {
  resolve(name: SecretName): Secret | null;
}

// The forms in which a secret can echo into an output: as typed, URI-encoded, base64 or base64url
// encoded, cut short to a prefix, or with its letters' case changed.
export const LEAK_FORMS = ['raw', 'uri', 'base64', 'base64url', 'prefix', 'case'] as const;
export type LeakForm = (typeof LEAK_FORMS)[number];
export type Leak = { readonly file: string; readonly secret: SecretName; readonly form: LeakForm };

// Looks for echoes of secrets in files a run produced. The caller plants a canary secret in one
// file, so a scan that finds nothing can be told from a scan that cannot see.
export interface LeakScanner {
  scan(files: readonly string[], secrets: readonly Secret[]): readonly Leak[];
}

const PLACEHOLDER = '[secret]';
// The key Node's util.inspect looks up for an object's own description.
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

// Values live here, keyed by the Secret object, never on the object itself: no property, getter or
// hidden field of a Secret holds its value, so nothing that walks the object can find it.
const SECRET_VALUES = new WeakMap<Secret, string>();

class OpaqueSecret implements Secret {
  readonly name: SecretName;

  constructor(name: SecretName) {
    this.name = name;
    Object.freeze(this);
  }

  toString(): string { return PLACEHOLDER; }
  toJSON(): string { return PLACEHOLDER; }
  [INSPECT](): string { return PLACEHOLDER; }
}

// Wraps a value a secret store read. Creating a Secret reveals nothing, so any store may call it.
export function createSecret(name: SecretName, value: string): Secret {
  const secret = new OpaqueSecret(name);
  SECRET_VALUES.set(secret, value);
  return secret;
}

// True for a Secret made by createSecret, without reading its value: a plain object that merely
// has a name is not one.
export const isSecret = (value: unknown): value is Secret =>
  typeof value === 'object' && value !== null && SECRET_VALUES.has(value as Secret);

// The secret's value. Only allow-listed modules may import this; see the comment at the top.
export function reveal(secret: Secret): string {
  const value = SECRET_VALUES.get(secret);
  if (value === undefined) throw new TypeError('not a secret made by createSecret');
  return value;
}
