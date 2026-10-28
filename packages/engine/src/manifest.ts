// The run manifest: every input that decides a run's result, hashed, so a run can be replayed and
// compared. See docs/specs/SPEC-08-manifest-and-replay.md.
import type { AdapterInfo, Plan, RedactionMode, SecretName, Target } from '@revisum/contracts';
import { canonicalJson, sha256 } from './hashing.ts';
import { ENGINE_VERSION, schemaId } from './version.ts';

// A file of the app under test, by content hash.
export type FixtureReference = { readonly path: string; readonly sha256: string };
export type HostInfo = { readonly platform: string; readonly arch: string };
// A secret the plan used, by name, and how its echoes are redacted. Never its value.
export type SecretRecord = { readonly name: SecretName; readonly mode: RedactionMode };
// Saved browser storage state the plan used, by secret name and the sha256 of its content.
export type StorageStateRecord = { readonly name: SecretName; readonly sha256: string };

export type RunManifest = {
  readonly schema: string;
  readonly engineVersion: string;
  readonly planHash: string;
  readonly target: Target;
  readonly adapter: AdapterInfo;
  readonly browser: { readonly name: string; readonly version: string };
  readonly seeds: { readonly random: number };
  readonly clock: { readonly fixedTimeMilliseconds: number };
  // Content hashes of the app under test. The base URL, and so its port, is left out on purpose.
  readonly fixtures: readonly FixtureReference[];
  readonly host: HostInfo;
  // Inputs the run could not pin. Empty means fully hermetic for this target environment.
  readonly nonHermeticInputs: readonly string[];
  // Present only when the plan uses secrets or storage state, so other runs' manifests and their
  // hashes stay exactly as they were.
  readonly secrets?: readonly SecretRecord[];
  readonly storageState?: StorageStateRecord;
};

export const planHash = (plan: Plan): string => sha256(canonicalJson(plan));

export function buildManifest(inputs: {
  readonly plan: Plan; readonly target: Target; readonly adapter: AdapterInfo;
  readonly browser: { readonly name: string; readonly version: string };
  readonly seed: number; readonly fixedTimeMilliseconds: number;
  readonly fixtures: readonly FixtureReference[]; readonly host: HostInfo;
  readonly secrets?: readonly SecretRecord[]; readonly storageState?: StorageStateRecord;
}): RunManifest {
  const secrets = inputs.secrets === undefined || inputs.secrets.length === 0
    ? {}
    : { secrets: [...inputs.secrets].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) };
  return {
    schema: schemaId('run-manifest', 1),
    engineVersion: ENGINE_VERSION,
    planHash: planHash(inputs.plan),
    target: inputs.target,
    adapter: inputs.adapter,
    browser: inputs.browser,
    seeds: { random: inputs.seed },
    clock: { fixedTimeMilliseconds: inputs.fixedTimeMilliseconds },
    fixtures: [...inputs.fixtures].sort((left, right) => (left.path < right.path ? -1 : 1)),
    host: inputs.host,
    nonHermeticInputs: [],
    ...secrets,
    ...(inputs.storageState === undefined ? {} : { storageState: inputs.storageState }),
  };
}

export const manifestHash = (manifest: RunManifest): string => sha256(canonicalJson(manifest));
