// Compile-time guarantee for manifest-perturbation.test.ts: its tables are typed over every key of
// Required<RunManifest> (with the added replay fields), so a manifest field with no perturbation case
// fails to compile. Type-checked by test/proofs/type-check.test.ts, never run.
import type { RunManifest } from '@revisum/engine';
import type { ManifestUnderTest } from './replay-examples.ts';

type Case = 'perturbed';

// Every field has its case: this compiles.
export const EVERY_FIELD: { readonly [Field in keyof Required<RunManifest['seeds']>]: Case } = { random: 'perturbed' };

// A table that leaves out one field, as a new optional field without a case would: it must not compile.
// @ts-expect-error commit has no case, and Required makes the optional field a required key
export const ONE_FIELD_LEFT_OUT: { readonly [Field in keyof Required<ManifestUnderTest>]: Case } = {
  schema: 'perturbed', engineVersion: 'perturbed', planHash: 'perturbed', target: 'perturbed', adapter: 'perturbed', browser: 'perturbed',
  seeds: 'perturbed', clock: 'perturbed', fixtures: 'perturbed', host: 'perturbed', nonHermeticInputs: 'perturbed', secrets: 'perturbed',
  storageState: 'perturbed', unsafeFeatures: 'perturbed', unsafeDeclarations: 'perturbed', responseRewrites: 'perturbed', evidence: 'perturbed',
  executableSha256: 'perturbed', projectHash: 'perturbed', versions: 'perturbed', redactor: 'perturbed', limits: 'perturbed',
  baselinesHash: 'perturbed', rulesetHash: 'perturbed', imageDigest: 'perturbed', fontsSha256: 'perturbed',
};

// The same holds inside versions.
// @ts-expect-error packs has no case
export const ONE_VERSION_LEFT_OUT: { readonly [Field in keyof Required<NonNullable<ManifestUnderTest['versions']>>]: Case } = {
  core: 'perturbed', act: 'perturbed', axe: 'perturbed', node: 'perturbed',
};
