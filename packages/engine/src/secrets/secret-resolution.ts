// Resolves the secrets a plan names, once, before a run opens any browser: every fill's
// { secretName }, the plan's saved storage state, and the secrets its declared calls use, in their
// headers or as arguments. The first name the store cannot resolve stops the run as secret-missing. The resolved secrets give the run its redaction and its manifest
// records; their values stay inside the opaque Secret objects.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import {
  failure, success,
  type CallDeclaration, type CallName, type Plan, type Redactor, type Result, type Secret, type SecretName, type SecretStore, type Step,
} from '@revisum/contracts';
import type { SecretRecord, StorageStateRecord } from '../manifest.ts';
import { redactionModeOf, secretRedaction, secretSha256, storageStateSecrets } from './secret-values.ts';

export type ResolvedSecrets = {
  // The secrets fill steps name, by name.
  readonly fills: ReadonlyMap<SecretName, Secret>;
  readonly storageState: Secret | null;
  // The secrets declared calls use, by name.
  readonly services: ReadonlyMap<SecretName, Secret>;
};

export const NO_SECRETS: ResolvedSecrets = { fills: new Map(), storageState: null, services: new Map() };

// The secret names the plan's calls use, its cleanup included, in plan order: each declaration's
// header secrets, then the secrets passed as arguments.
function callSecretNames(plan: Plan, calls: Readonly<Record<CallName, CallDeclaration>>): SecretName[] {
  const steps = [...plan.steps, ...(plan.cleanup ?? [])];
  return steps.flatMap((step) => {
    if (step.type !== 'call' && step.type !== 'expectBackend') return [];
    const declaration = Object.entries(calls).find(([name]) => name === step.call)?.[1];
    const headers = Object.values(declaration?.headers ?? {}).flatMap((header) => ('secretName' in header ? [header.secretName] : []));
    const passed = Object.values(step.arguments).flatMap((argument) => (typeof argument === 'object' && 'secretName' in argument ? [argument.secretName] : []));
    return [...headers, ...passed];
  });
}

// The secret names fill steps use, inside frames and second tabs too, in plan order.
function fillSecretNames(steps: readonly Step[]): SecretName[] {
  return steps.flatMap((step) => {
    if (step.type === 'frame' || step.type === 'newTab') return fillSecretNames(step.steps);
    return step.type === 'fill' && typeof step.value !== 'string' && 'secretName' in step.value ? [step.value.secretName] : [];
  });
}

// Without a store, every name is missing: a run never falls back to typing nothing.
export function resolvePlanSecrets(
  plan: Plan, store: SecretStore | undefined, calls: Readonly<Record<CallName, CallDeclaration>>,
): Result<ResolvedSecrets, SecretName> {
  const resolveAll = (names: readonly SecretName[]): Result<Map<SecretName, Secret>, SecretName> => {
    const resolved = new Map<SecretName, Secret>();
    for (const name of names) {
      if (resolved.has(name)) continue;
      const secret = store?.resolve(name) ?? null;
      if (secret === null) return failure(name);
      resolved.set(name, secret);
    }
    return success(resolved);
  };
  const fills = resolveAll(fillSecretNames(plan.steps));
  if (!fills.ok) return fills;
  const storageState = plan.storageState === undefined ? null : store?.resolve(plan.storageState.secretName) ?? null;
  if (plan.storageState !== undefined && storageState === null) return failure(plan.storageState.secretName);
  const services = resolveAll(callSecretNames(plan, calls));
  if (!services.ok) return services;
  return success({ fills: fills.value, storageState, services: services.value });
}

// The store a declared call's request is built from: only the secrets the run resolved before it
// started, so a call never reaches past them.
export const resolvedSecretStore = (secrets: ResolvedSecrets): SecretStore => ({ resolve: (name) => secrets.services.get(name) ?? null });

// The run's redactor: the caller's personal-data redaction, with every echo of the resolved secrets
// removed first, so a pattern match cannot split a secret and leave part of it behind. Saved
// storage state is redacted as a whole and by each cookie and stored value inside it.
export function withSecretRedaction(redactor: Redactor, secrets: ResolvedSecrets): Redactor {
  const storage = secrets.storageState === null ? [] : [secrets.storageState, ...storageStateSecrets(secrets.storageState)];
  const watched = [...secrets.fills.values(), ...secrets.services.values(), ...storage];
  if (watched.length === 0) return redactor;
  const redactSecrets = secretRedaction(watched);
  return { selectors: redactor.selectors, text: (value) => redactor.text(redactSecrets(value)) };
}

// What the manifest records: each fill's and call's secret by name and redaction mode, once, and the
// storage state's name and content hash.
export function secretRecords(secrets: ResolvedSecrets): { readonly secrets: readonly SecretRecord[]; readonly storageState?: StorageStateRecord } {
  const named = new Map([...secrets.fills, ...secrets.services]);
  const records = [...named].map(([name, secret]): SecretRecord => ({ name, mode: redactionModeOf(secret) }));
  return secrets.storageState === null
    ? { secrets: records }
    : { secrets: records, storageState: { name: secrets.storageState.name, sha256: secretSha256(secrets.storageState) } };
}
