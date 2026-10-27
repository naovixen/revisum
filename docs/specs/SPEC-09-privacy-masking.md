# SPEC-09: Privacy masking

## Purpose

Keep every output privacy-minimal (R7): log only what is needed, say so, and keep personal data out of images, reports and API evidence. It serves "we can't prove what was tested, against which spec, or by whom" (UP-08) and "letting AI agents into our pipeline feels like handing over the keys" (UP-09): evidence can be shared without leaking customer data.

## Scope and non-goals

- **In:** masks and probes in an isolated world page script cannot tamper with; every form control masked by default, including text inputs, shadow DOM and iframes; a PII pass on API evidence and free text before anything is written; masked-only images in reports, PR images and stills; a logging manifest generated from code covering every output and every AI egress, each with a reason and retention; seeded-PII fixtures.
- **Non-goals:** hosted retention jobs (SPEC-24); people-data rules for metrics (SPEC-14).

## Interfaces and types

```ts
export type HttpMessage = { readonly headers: Readonly<Record<string, string>>; readonly body: string | null };
export type HttpExchange = {
  readonly request: HttpMessage & { readonly method: string; readonly url: string };
  readonly response: HttpMessage & { readonly status: number };
};
export interface Redactor {
  maskSelectors(): readonly string[];                // applied in an isolated world at capture
  redactText(text: string): { text: string; hits: readonly PiiKind[] };
  redactExchange(exchange: HttpExchange): HttpExchange;     // headers, JSON bodies, query strings
}
export type PiiKind = 'email' | 'phone' | 'name' | 'birth-date' | 'address' | 'card' | 'national-id' | 'declared-field';
export type LoggingManifestEntry = { output: string; field: string; reason: string; retentionDays: number };
export function loggingManifest(): readonly LoggingManifestEntry[]; // generated from the logger and writers
```

## Acceptance criteria

- AC-SPEC-09-01: When seeded-PII fixtures run, no seeded value shall appear in any screenshot (checked by OCR and pixel comparison with the masked render), report, PR comment, result, event or API evidence file (oracle: specified).
- AC-SPEC-09-02: When page script tries to remove or restyle a mask, the captured image shall still be masked (oracle: specified).
- AC-SPEC-09-03: When a form control of any type, including inside shadow DOM or an iframe, is captured, it shall be masked unless the project unmasks it by selector (oracle: specified).
- AC-SPEC-09-04: When the red-team probe passes an email, a name and a birth date through API evidence, each shall be redacted (oracle: regression).
- AC-SPEC-09-05: When a writer emits a field that is not in the generated logging manifest, the build shall fail (oracle: specified).
- AC-SPEC-09-06: When the trust page is built, it shall render the logging manifest from code, with every output, field, reason and retention (oracle: specified).
- AC-SPEC-09-07: When any PII rule or mask selector changes, the manifest's `redactor` hash shall change (oracle: metamorphic).

## Dependencies

- SPEC-04, SPEC-06, SPEC-08 (adds PII rules to the `redactor` hash). The core skeleton's logging and redaction modules (spike P3 `logging.ts` and `redact.ts`).
- Research background: architecture (`04` Finding 8), including GDPR data minimisation.

## Milestone

M3.

## Satisfies

NFR-05
