# SPEC-04: Secrets and redaction

## Purpose

Secrets must never reach plans, results, evidence or logs. It serves "letting AI agents into our pipeline feels like handing over the keys" (UP-09): teams can let agents draft plans without giving them credentials. Outcome: secrets are references resolved at execution, opaque in code, and redacted from every artefact, including short and re-encoded echoes.

## Scope and non-goals

- **In:** secret references in plans (`{ secretName }`); an opaque `Secret` type with a static reveal allow-list; saved browser storage state as a human-authored secret; redaction by value in raw, URI, base64 and base64url forms, case-insensitive; key-only redaction for secrets under the minimum length; a leak scanner with a planted canary over every output.
- **Non-goals:** a vault integration (later port adapter); PII masking (SPEC-09). The redaction config's version hash feeds the manifest's `redactor` field (SPEC-08).

## Interfaces and types

```ts
export type SecretName = Brand<string, 'SecretName'>;
export interface Secret { readonly name: SecretName }       // toString, toJSON, inspect give "[secret]"
export interface SecretStore { resolve(name: SecretName): Secret | null } // reads CI secrets from the environment in the MVP
export function reveal(secret: Secret): string;                   // importable only by allow-listed modules
export type RedactionMode = 'value' | 'key-only';            // key-only below MINIMUM_SECRET_LENGTH
export const MINIMUM_SECRET_LENGTH = 8;
export interface LeakScanner { scan(files: readonly string[], secrets: readonly Secret[]): readonly Leak[] }
export type Leak = { file: string; secret: SecretName; form: 'raw' | 'uri' | 'base64' | 'base64url' | 'prefix' | 'case' };
```

## Acceptance criteria

- AC-SPEC-04-01: When `JSON.stringify`, `String()` or `util.inspect` is applied to a `Secret`, the output shall be `[secret]` (oracle: specified; reuses AC-p7-31).
- AC-SPEC-04-02: When a module outside the allow-list imports `reveal`, the static check shall fail (oracle: specified; reuses AC-p7-31).
- AC-SPEC-04-03: When a plan holds a literal value in a secret field, core shall reject it with `literal-secret` (oracle: specified; reuses AC-p7-06).
- AC-SPEC-04-04: When the leak scan runs over every result, event, report, image text layer and log, it shall find zero echoes of planted secrets in raw, URI, base64, base64url, prefix and case-changed forms, and shall find its planted canary (oracle: specified; extends AC-p7-32 with the red-team probe cases).
- AC-SPEC-04-05: When a declared secret is shorter than `MINIMUM_SECRET_LENGTH`, core shall redact by key and say so in the manifest (oracle: specified).
- AC-SPEC-04-06: When a plan uses saved browser storage state, core shall resolve it through `SecretStore` like any secret, load it only into the session, and record only its name and file hash in the manifest; no cookie or token value from it shall appear in any artefact (oracle: specified; leak scan with planted storage-state values).
- AC-SPEC-04-07: When a plan's `secretName` names a secret the store can't resolve, the run shall end before any side effect with `secret-missing`, naming the secret but no value (oracle: specified).

## Dependencies

- SPEC-01. The API-step spike's secret and redaction modules (P7 `secret.ts` and `redact.ts`).
- Research background: the secrets row of the guarantee table (`04` Finding 1) and the red-team probe results.

## Milestone

M1.

## Satisfies

NFR-04
