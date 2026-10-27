// The run manifest: every input that decides a run's result, hashed, so a run can be replayed and
// compared. See docs/specs/SPEC-08-manifest-and-replay.md.
import type { AdapterInfo, Plan, Target } from '@revisum/contracts';
import { canonicalJson, sha256 } from './hashing.ts';
import { ENGINE_VERSION, schemaId } from './version.ts';

// A file of the app under test, by content hash.
export type FixtureReference = { readonly path: string; readonly sha256: string };
export type HostInfo = { readonly platform: string; readonly arch: string };

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
};

export const planHash = (plan: Plan): string => sha256(canonicalJson(plan));

export function buildManifest(inputs: {
  readonly plan: Plan; readonly target: Target; readonly adapter: AdapterInfo;
  readonly browser: { readonly name: string; readonly version: string };
  readonly seed: number; readonly fixedTimeMilliseconds: number;
  readonly fixtures: readonly FixtureReference[]; readonly host: HostInfo;
}): RunManifest {
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
  };
}

export const manifestHash = (manifest: RunManifest): string => sha256(canonicalJson(manifest));
