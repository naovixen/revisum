// Resolves the secrets a plan names, once, before a run opens any browser: every fill's
// { secretName } and the plan's saved storage state. The first name the store cannot resolve stops
// the run as secret-missing. The resolved secrets give the run its redaction and its manifest
// records; their values stay inside the opaque Secret objects.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import {
  failure, success,
  type Plan, type Redactor, type Result, type Secret, type SecretName, type SecretStore, type Step,
} from '@revisum/contracts';
import type { SecretRecord, StorageStateRecord } from '../manifest.ts';
import { redactionModeOf, secretRedaction, secretSha256, storageStateSecrets } from './secret-values.ts';

export type ResolvedSecrets = {
  // The secrets fill steps name, by name.
  readonly fills: ReadonlyMap<SecretName, Secret>;
  readonly storageState: Secret | null;
};

export const NO_SECRETS: ResolvedSecrets = { fills: new Map(), storageState: null };

// The secret names fill steps use, inside frames too, in plan order.
function fillSecretNames(steps: readonly Step[]): SecretName[] {
  return steps.flatMap((step) => {
    if (step.type === 'frame') return fillSecretNames(step.steps);
    return step.type === 'fill' && typeof step.value !== 'string' ? [step.value.secretName] : [];
  });
}

// Without a store, every name is missing: a run never falls back to typing nothing.
export function resolvePlanSecrets(plan: Plan, store: SecretStore | undefined): Result<ResolvedSecrets, SecretName> {
  const fills = new Map<SecretName, Secret>();
  for (const name of fillSecretNames(plan.steps)) {
    if (fills.has(name)) continue;
    const secret = store?.resolve(name) ?? null;
    if (secret === null) return failure(name);
    fills.set(name, secret);
  }
  if (plan.storageState === undefined) return success({ fills, storageState: null });
  const storageState = store?.resolve(plan.storageState.secretName) ?? null;
  if (storageState === null) return failure(plan.storageState.secretName);
  return success({ fills, storageState });
}

// The run's redactor: the caller's personal-data redaction, with every echo of the resolved secrets
// removed first, so a pattern match cannot split a secret and leave part of it behind. Saved
// storage state is redacted as a whole and by each cookie and stored value inside it.
export function withSecretRedaction(redactor: Redactor, secrets: ResolvedSecrets): Redactor {
  const storage = secrets.storageState === null ? [] : [secrets.storageState, ...storageStateSecrets(secrets.storageState)];
  const watched = [...secrets.fills.values(), ...storage];
  if (watched.length === 0) return redactor;
  const redactSecrets = secretRedaction(watched);
  return { selectors: redactor.selectors, text: (value) => redactor.text(redactSecrets(value)) };
}

// What the manifest records: each fill secret's name and redaction mode, and the storage state's
// name and content hash.
export function secretRecords(secrets: ResolvedSecrets): { readonly secrets: readonly SecretRecord[]; readonly storageState?: StorageStateRecord } {
  const records = [...secrets.fills].map(([name, secret]): SecretRecord => ({ name, mode: redactionModeOf(secret) }));
  return secrets.storageState === null
    ? { secrets: records }
    : { secrets: records, storageState: { name: secrets.storageState.name, sha256: secretSha256(secrets.storageState) } };
}
