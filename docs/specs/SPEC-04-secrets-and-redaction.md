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

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; `docs/decisions/answers.md`):

- **Secret fields (AC-SPEC-04-03).** Two rules, both rejected with `literal_secret`:
  - a `fill` with literal text into a control whose locator names a sensitive field (password, passcode, token, secret, API key, and the `de` and `fr` equivalents);
  - a token-shaped literal anywhere in plan text (JSON Web Token, `Bearer …`, and well-known key prefixes such as `ghp_`, `sk-` and `AKIA`), as the API-step spike did.

  Plans log in with `{ secretName }`. The coverage-study re-run declares secret names in its stand-in project accordingly.
- **Where `reveal` lives.** `Secret`, `SecretStore` and `reveal` live in `contracts`, so drivers and runner can use them without importing engine. The allow-list is one constant listing the modules that may import `reveal`: the drivers' input modules and engine's secret-values module, which redaction and the leak scan need and which returns only redacted text, found forms, the mode or a hash; and runner's service caller with SPEC-32.
- **The store.** `environmentSecretStore(variables)` maps a secret name to the variable of the same name. The run takes it as an optional `ports.secrets`; without one, every reference is missing. `leakScanner()` builds the scanner, and the caller plants the canary.
- **Fills.** The seeded drivers fill a `{ secretName }` value now, revealing it only at the moment of input. The guard and every log see only the name.
- **Missing secrets (AC-SPEC-04-07).** The run is refused before any driver opens, with refusal code `secret-missing` and the secret's name. The code gets a heading in `docs/errors.md`.
- **Manifest (AC-SPEC-04-05, 06).** Secret fields appear only when a plan uses secrets, so runs without secrets keep today's manifest exactly:
  - `secrets`: name and redaction mode per secret;
  - `storageState`: name and sha256.
- **Saved storage state (AC-SPEC-04-06).** A plan names it in an optional top-level `storageState: { secretName }`, added to plan 1.1 with a changelog entry. The secret's value is the storage-state JSON. The parser, store resolution, manifest record and leak scan land now. Loading it into the browser session comes with SPEC-06's `SessionEnvironment`.
- **Watch.** The seeded replay proof failed once on Playwright Firefox during a full check under load, and passed on rerun.
- **Leak scan scope.** "Image text layer" means the image bytes, PNG text chunks included; there is no text recognition. The visual report joins the scan when SPEC-11 and SPEC-12 produce it.

## Acceptance criteria

- AC-SPEC-04-01: When `JSON.stringify`, `String()` or `util.inspect` is applied to a `Secret`, the output shall be `[secret]` (oracle: specified; reuses AC-p7-31).
- AC-SPEC-04-02: When a module outside the allow-list imports `reveal`, the static check shall fail (oracle: specified; reuses AC-p7-31).
- AC-SPEC-04-03: When a plan holds a literal value in a secret field, core shall reject it with `literal_secret` (oracle: specified; reuses AC-p7-06).
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
