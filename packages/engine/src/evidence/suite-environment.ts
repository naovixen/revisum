// A declared suite's environment: its literals as written, and its secrets resolved through the
// secret store and kept opaque, so only the workload runner ever reveals them, as it writes the
// container's environment. The resolved secrets also give the suite run its redactor, so every
// echo of them is removed from whatever the suite prints or reports.
// See docs/specs/SPEC-35-evidence-mode.md and docs/specs/SPEC-04-secrets-and-redaction.md.
import {
  failure, success,
  type EvidenceSuiteDeclaration, type Redactor, type Result, type Secret, type SecretName, type SecretStore, type WorkloadVariable,
} from '@revisum/contracts';
import { NO_SECRETS, withSecretRedaction } from '../secrets/secret-resolution.ts';

export type SuiteEnvironment = { readonly variables: readonly WorkloadVariable[]; readonly secrets: readonly Secret[] };

// The suite's variables in declaration order, or the first secret name the store cannot resolve.
export function suiteEnvironment(suite: EvidenceSuiteDeclaration, store: SecretStore): Result<SuiteEnvironment, SecretName> {
  const variables: WorkloadVariable[] = [];
  const secrets: Secret[] = [];
  for (const [name, value] of Object.entries(suite.environment)) {
    if ('literal' in value) {
      variables.push({ name, value: value.literal });
      continue;
    }
    const secret = store.resolve(value.secretName);
    if (secret === null) return failure(value.secretName);
    secrets.push(secret);
    variables.push({ name, value: secret });
  }
  return success({ variables, secrets });
}

// The caller's redactor with every echo of the suite's secrets removed first.
export const suiteRedactor = (redactor: Redactor, secrets: readonly Secret[]): Redactor =>
  withSecretRedaction(redactor, { ...NO_SECRETS, services: new Map(secrets.map((secret) => [secret.name, secret])) });
