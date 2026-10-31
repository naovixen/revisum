// The run manifest: every input that decides a run's result, hashed, so a run can be replayed and
// compared. See docs/specs/SPEC-08-manifest-and-replay.md.
import {
  failure, success,
  type AdapterInfo, type AppliedRewrite, type EvidenceSuiteDeclaration, type ImageDigest, type Plan, type RedactionMode, type Result, type SecretName,
  type SuiteName, type Target, type UnsafeFeature,
} from '@revisum/contracts';
import { canonicalJson, sha256 } from './hashing.ts';
import { declarationsNamedBy, unsafeFeaturesOf } from './plan/unsafe-features.ts';
import type { Project } from './project/project-parser.ts';
import { declaredCommands, declaredScripts } from './project/unsafe-feature-declarations.ts';
import { ENGINE_VERSION, schemaId } from './version.ts';

// A file of the app under test, by content hash.
export type FixtureReference = { readonly path: string; readonly sha256: string };
export type HostInfo = { readonly platform: string; readonly arch: string };
// A secret the plan used, by name, and how its echoes are redacted. Never its value.
export type SecretRecord = { readonly name: SecretName; readonly mode: RedactionMode };
// Saved browser storage state the plan used, by secret name and the sha256 of its content.
export type StorageStateRecord = { readonly name: SecretName; readonly sha256: string };
// A page script or database command the plan names, by its declared name: a script by the sha256
// of its source file, a command by the sha256 of its whole declaration, so one byte of either
// changes the manifest hash.
export type UnsafeDeclarationRecord = { readonly kind: 'script' | 'command'; readonly name: string; readonly sha256: string };
// What a run of a plan using unsafe features records beside its plan hash.
export type UnsafeFeatureRecord = { readonly unsafeFeatures: readonly UnsafeFeature[]; readonly unsafeDeclarations: readonly UnsafeDeclarationRecord[] };

export type RunManifest = {
  readonly schema: string;
  readonly engineVersion: string;
  // For an evidence run, which has no plan, the sha256 of the suite's declaration, which decides
  // what ran.
  readonly planHash: string;
  // The target, adapter and browser of a plan run. An evidence run has none of its own: the
  // suite's own browser is self-reported in its evidence record.
  readonly target?: Target;
  readonly adapter?: AdapterInfo;
  readonly browser?: { readonly name: string; readonly version: string };
  // An evidence run fixes neither, so both are 0 for it; its evidence record says why.
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
  // Present only when the plan uses an unsafe feature, as for secrets, so a closed run's manifest
  // and its hash stay exactly as they were.
  readonly unsafeFeatures?: readonly UnsafeFeature[];
  readonly unsafeDeclarations?: readonly UnsafeDeclarationRecord[];
  // Present only when the egress proxy applied a browser mutant's rewrite, so a mutated run can
  // never pass for a plain one, and a plain run's manifest and hash stay as they were.
  readonly responseRewrites?: readonly AppliedRewrite[];
  // Present only for an evidence run, so a plan run's manifest and hash stay exactly as they were.
  readonly evidence?: EvidenceManifestRecord;
};

// What pins an evidence run, as far as anything can: the suite's files, its commands and its image.
// What the suite says about its own Playwright and browsers is recorded but marked self-reported,
// since Revisum cannot check it.
export type EvidenceManifestRecord = {
  readonly suite: SuiteName;
  // The sha256 of the sorted list of the suite's files, each by path and content hash.
  readonly suiteFiles: { readonly count: number; readonly sha256: string };
  // The sha256 of the declared command and setup command, as argument vectors.
  readonly commandSha256: string;
  readonly image: ImageDigest;
  readonly selfReported: { readonly playwrightVersion: string | null; readonly browsers: readonly string[] };
};

// Inputs an evidence run can never pin: the team's test code, the browser its suite brings, and
// the app server the suite starts.
export const EVIDENCE_NON_HERMETIC_INPUTS: readonly string[] = ['app-server', 'suite-browser', 'suite-code'];

// A file of the suite, by repository-relative path and content.
export type SuiteFile = { readonly path: string; readonly bytes: Uint8Array };

export type EvidenceManifestInputs = {
  readonly suite: EvidenceSuiteDeclaration;
  readonly suiteFiles: readonly SuiteFile[];
  readonly playwrightVersion?: string | undefined;
  readonly browsers: readonly string[];
  readonly host: HostInfo;
};

export function evidenceManifest(inputs: EvidenceManifestInputs): RunManifest {
  const files = inputs.suiteFiles.map((file) => ({ path: file.path, sha256: sha256(file.bytes) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const { suite } = inputs;
  return {
    schema: schemaId('run-manifest', 1),
    engineVersion: ENGINE_VERSION,
    planHash: sha256(canonicalJson(suite)),
    seeds: { random: 0 },
    clock: { fixedTimeMilliseconds: 0 },
    fixtures: [],
    host: inputs.host,
    nonHermeticInputs: EVIDENCE_NON_HERMETIC_INPUTS,
    evidence: {
      suite: suite.name,
      suiteFiles: { count: files.length, sha256: sha256(canonicalJson(files)) },
      commandSha256: sha256(canonicalJson({ command: suite.command, setupCommand: suite.setupCommand ?? null })),
      image: suite.image,
      selfReported: { playwrightVersion: inputs.playwrightVersion ?? null, browsers: [...new Set(inputs.browsers)].sort() },
    },
  };
}

// Why a manifest cannot be replayed.
//   replay-not-claimed: it is an evidence run's, whose suite code, browser and app server no
//     manifest can pin. It can still be run again from the manifest, but not claimed identical.
export type ReplayErrorCode = 'replay-not-claimed';

// The manifest a replay would run, or why none may. The replay itself, which runs the manifest
// again and compares result hashes, is SPEC-08's.
export function replayManifest(manifest: RunManifest): Result<RunManifest, { readonly code: ReplayErrorCode }> {
  return manifest.evidence === undefined ? success(manifest) : failure({ code: 'replay-not-claimed' });
}

export const planHash = (plan: Plan): string => sha256(canonicalJson(plan));

// The non-hermetic input of a run that calls declared services: their responses.
export const SERVICE_CALLS_INPUT = 'service-calls';
// The non-hermetic input of a run that runs database commands: their outputs, and the state of the
// database they ran against, which no manifest can pin.
export const DATABASE_COMMANDS_INPUT = 'database-commands';

// What the manifest records about the plan's unsafe features: the features, and each declaration
// the plan names, with its sha256. Undefined for a closed plan. A named script whose source the run
// was not given is reported by its file, so the run can be refused rather than record no hash.
export function unsafeFeatureRecord(
  plan: Plan, project: Project, scriptSources: Readonly<Record<string, Uint8Array>>,
): Result<UnsafeFeatureRecord | undefined, string> {
  const unsafeFeatures = unsafeFeaturesOf(plan);
  if (unsafeFeatures.length === 0) return success(undefined);
  const named = declarationsNamedBy(plan);
  const scripts = Object.entries(declaredScripts(project.unsafeFeatures)).filter(([name]) => named.scripts.some((used) => used === name));
  const commands = Object.entries(declaredCommands(project.unsafeFeatures)).filter(([name]) => named.commands.some((used) => used === name));
  const records: UnsafeDeclarationRecord[] = [];
  for (const [name, declaration] of scripts) {
    const source = Object.hasOwn(scriptSources, declaration.file) ? scriptSources[declaration.file] : undefined;
    if (source === undefined) return failure(declaration.file);
    records.push({ kind: 'script', name, sha256: sha256(source) });
  }
  for (const [name, declaration] of commands) records.push({ kind: 'command', name, sha256: sha256(canonicalJson(declaration)) });
  const order = (record: UnsafeDeclarationRecord): string => `${record.kind}:${record.name}`;
  return success({ unsafeFeatures, unsafeDeclarations: records.sort((left, right) => (order(left) < order(right) ? -1 : 1)) });
}

// The service-call responses first, as before, then any other unpinned inputs, sorted and once
// each. A run with none of the others has exactly the list it always had, so its hash is unchanged.
function nonHermeticInputs(callsServices: boolean, others: readonly string[]): readonly string[] {
  const rest = [...new Set(others)].filter((input) => input !== SERVICE_CALLS_INPUT).sort();
  return callsServices ? [SERVICE_CALLS_INPUT, ...rest] : rest;
}

export function buildManifest(inputs: {
  readonly plan: Plan; readonly target: Target; readonly adapter: AdapterInfo;
  readonly browser: { readonly name: string; readonly version: string };
  readonly seed: number; readonly fixedTimeMilliseconds: number;
  readonly fixtures: readonly FixtureReference[]; readonly host: HostInfo;
  readonly secrets?: readonly SecretRecord[]; readonly storageState?: StorageStateRecord;
  // True when the plan calls declared services, whose responses the run cannot pin.
  readonly callsServices?: boolean;
  // Present when the plan uses unsafe features (unsafeFeatureRecord).
  readonly unsafe?: UnsafeFeatureRecord;
  // Other inputs the run could not pin, such as a browser build the lockfile does not cover.
  readonly unpinned?: readonly string[];
  // The browser mutants' rewrites the egress proxy applied (EgressProxy.rewritesApplied).
  readonly responseRewrites?: readonly AppliedRewrite[];
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
    nonHermeticInputs: nonHermeticInputs(inputs.callsServices === true, [...(inputs.adapter.cannotPin ?? []), ...(inputs.unpinned ?? [])]),
    ...secrets,
    ...(inputs.storageState === undefined ? {} : { storageState: inputs.storageState }),
    ...(inputs.unsafe === undefined ? {} : inputs.unsafe),
    ...(inputs.responseRewrites === undefined || inputs.responseRewrites.length === 0 ? {} : {
      responseRewrites: inputs.responseRewrites.map((applied) => ({ origin: applied.origin, name: applied.name }))
        .sort((left, right) => (left.origin === right.origin ? (left.name < right.name ? -1 : 1) : (left.origin < right.origin ? -1 : 1))),
    }),
  };
}

export const manifestHash = (manifest: RunManifest): string => sha256(canonicalJson(manifest));
