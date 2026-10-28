// The MVP secret store: CI secrets passed to the job as environment variables. A secret name maps
// to the variable of the same name. A later vault adapter implements the same SecretStore port.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import { createSecret, type SecretName, type SecretStore } from '@revisum/contracts';

// `variables` is usually process.env. An empty variable counts as missing: CI systems such as
// GitHub Actions expand a secret that is not set to empty text, and typing nothing into a login
// form would only fail later and less clearly.
export function environmentSecretStore(variables: Readonly<Record<string, string | undefined>>): SecretStore {
  return {
    resolve(name: SecretName) {
      const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
      return typeof value === 'string' && value !== '' ? createSecret(name, value) : null;
    },
  };
}
