// Runner's side of the ServiceCaller port: the one runner module that may read a secret. A declared
// call's request carries each secret header, and each secret in its JSON body, as an opaque Secret;
// it is revealed only here, as the request is written for sending, so no other code holds the text.
// A workload's declared secrets are revealed here too, as its container's environment is written
// (docs/specs/SPEC-35-evidence-mode.md).
// The caller itself, which sends each request through the egress proxy after the resolve-time
// address check, never follows a redirect and stops reading at the size cap, comes with the egress
// proxy (docs/specs/SPEC-07-isolated-runner-and-egress.md).
// See docs/specs/SPEC-32-declared-service-calls.md.
import { reveal, type ServiceRequest, type ServiceRequestHeader, type WorkloadVariable } from '@revisum/contracts';

// The request's headers as name and value text, in the declaration's order, for writing on the wire.
export const headerFields = (headers: readonly ServiceRequestHeader[]): readonly (readonly [string, string])[] =>
  headers.map((header) => [header.name, typeof header.value === 'string' ? header.value : reveal(header.value)] as const);

// The request's body as the text sent: its parts joined, each secret written as one JSON string, so
// a value can never change the body's shape.
export const bodyText = (body: ServiceRequest['body']): string | null =>
  body === null ? null : body.jsonParts.map((part) => (typeof part === 'string' ? part : JSON.stringify(reveal(part)))).join('');

// A workload's declared variables as name and value text, in the declaration's order, for writing
// into its container's environment.
export const variableFields = (variables: readonly WorkloadVariable[]): readonly (readonly [string, string])[] =>
  variables.map((variable) => [variable.name, typeof variable.value === 'string' ? variable.value : reveal(variable.value)] as const);
