// The run manifest: every input that decides a run's result, hashed, so a run can be replayed and
// compared.
import {
  failure, isEvidenceManifest, success,
  type AdapterInfo, type AppliedRewrite, type EvidenceSuiteDeclaration, type Plan, type Result,
  type FixtureReference, type HostInfo, type EvidenceRunManifest, type PlanRunManifest, type RunManifest, type RunVersions, type SecretRecord, type StorageStateRecord, type Target,
  type UnsafeDeclarationRecord, type UnsafeFeature,
} from '@revisum/contracts';
import { canonicalJson, sha256 } from './hashing.ts';
import type { NamedScripts } from './page-scripts/NamedScriptSources.ts';
import { declarationsNamedBy, unsafeFeaturesOf } from './plan/unsafe-features.ts';
import type { Project } from './project/project-parser.ts';
import type { Provenance } from './project/trusted-project.ts';
import { declaredCommands } from './project/unsafe-feature-declarations.ts';
import { ENGINE_VERSION, schemaId } from './version.ts';

// What a run of a plan using unsafe features records beside its plan hash.
export type UnsafeFeatureRecord = { readonly unsafeFeatures: readonly UnsafeFeature[]; readonly unsafeDeclarations: readonly UnsafeDeclarationRecord[] };

// What cli's runPins() gathers about the machine and the repository a run starts on, which the
// engine cannot see for itself. The manifest copies each into the field of the same name.
export type RunPins = {
  readonly versions: RunVersions;
  // The sha256 of the PII patterns and mask selectors (the secrets themselves are in `secrets`).
  readonly redactor: string;
  // The sha256 of the own accessibility engine's rule ids and probe settings.
  readonly rulesetHash: string;
  // The sha256 of the sorted { path, sha256 } of every baseline the plan reads.
  readonly baselinesHash: string;
  // The run image's id. A run on the host has none, and its manifest lists run-image as unpinned.
  readonly imageDigest?: string;
  // The sha256 of every system font file's path and content hash, sorted.
  readonly fontsSha256: string;
  // The repository's HEAD commit, or null outside a Git checkout.
  readonly commit: string | null;
};

// Inputs an evidence run can never pin: the team's test code, the browser its suite brings, and
// the app server the suite starts.
const EVIDENCE_NON_HERMETIC_INPUTS: readonly string[] = ['app-server', 'suite-browser', 'suite-code'];

// A file of the suite, by repository-relative path and content.
export type SuiteFile = { readonly path: string; readonly bytes: Uint8Array };

export type EvidenceManifestInputs = {
  readonly suite: EvidenceSuiteDeclaration;
  readonly suiteFiles: readonly SuiteFile[];
  readonly playwrightVersion?: string | undefined;
  readonly browsers: readonly string[];
  readonly host: HostInfo;
};

const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

export function evidenceManifest(inputs: EvidenceManifestInputs): EvidenceRunManifest {
  const files = inputs.suiteFiles.map((file) => ({ path: file.path, sha256: sha256(file.bytes) }))
    .sort((left, right) => compareText(left.path, right.path));
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

// Why a manifest cannot be replayed, or why its replay is not a pass.
//   replay-not-claimed: no replay of this run may be claimed identical. It is an evidence run's,
//     whose suite code, browser and app server no manifest can pin; or its adapter could not pin
//     the clock, the time zone or randomness; or it called services or ran database commands
//     without recording their replies, which a replay never sends again.
//   replay-mismatch: what the replay was given does not match the manifest (a fixture, the plan,
//     the target, a field of the wrong shape or a recorded reply), so it never ran as a pass.
//   version-unsupported: the manifest or recording is of a schema version, or holds a key, this
//     engine does not read.
export const ReplayErrorCode = {
  ReplayNotClaimed: 'replay-not-claimed',
  ReplayMismatch: 'replay-mismatch',
  VersionUnsupported: 'version-unsupported',
} as const;

export type ReplayErrorCode = (typeof ReplayErrorCode)[keyof typeof ReplayErrorCode];

// The inputs an adapter may be unable to pin (AdapterInfo.cannotPin). A run whose adapter cannot
// pin any of them is never replay-claimed.
export const DETERMINISM_INPUTS: readonly string[] = ['clock', 'time-zone', 'randomness'];

// The non-hermetic input of a run whose pins name no run image: it ran on the host.
const RUN_IMAGE_INPUT = 'run-image';

// Listed beside service-calls or database-commands when the project records their replies
// (replay.recordReplies): those inputs are still not pinned by the manifest, but a replay can feed
// them from the run's recording. Without it, such a run is never replay-claimed.
const RECORDED_REPLIES_INPUT = 'recorded-replies';

// The manifest a replay may run, or why none may: a replay of it could never be claimed identical.
// The replay itself, which runs the manifest again and compares result hashes, is replay().
export function replayManifest(manifest: RunManifest): Result<PlanRunManifest, { readonly code: typeof ReplayErrorCode.ReplayNotClaimed }> {
  if (isEvidenceManifest(manifest)) return failure({ code: ReplayErrorCode.ReplayNotClaimed });
  const unpinned = manifest.nonHermeticInputs;
  if (unpinned.some((input) => DETERMINISM_INPUTS.includes(input))) return failure({ code: ReplayErrorCode.ReplayNotClaimed });
  const needsReplies = unpinned.includes(SERVICE_CALLS_INPUT) || unpinned.includes(DATABASE_COMMANDS_INPUT);
  if (needsReplies && !unpinned.includes(RECORDED_REPLIES_INPUT)) return failure({ code: ReplayErrorCode.ReplayNotClaimed });
  return success(manifest);
}

export const planHash = (plan: Plan): string => sha256(canonicalJson(plan));

// The non-hermetic input of a run that calls declared services: their responses.
export const SERVICE_CALLS_INPUT = 'service-calls';
// The non-hermetic input of a run that runs database commands: their outputs, and the state of the
// database they ran against, which no manifest can pin.
export const DATABASE_COMMANDS_INPUT = 'database-commands';

// What the manifest records about the plan's unsafe features: the features, and each declaration
// the plan names, with its sha256. Undefined for a closed plan.
export function unsafeFeatureRecord(plan: Plan, project: Project, scripts: NamedScripts): UnsafeFeatureRecord | undefined {
  const unsafeFeatures = unsafeFeaturesOf(plan);
  if (unsafeFeatures.length === 0) return undefined;
  const named = declarationsNamedBy(plan);
  const commands = Object.entries(declaredCommands(project.unsafeFeatures)).filter(([name]) => named.commands.some((used) => used === name));
  const records = [...scripts.values()].map(({ name, source }): UnsafeDeclarationRecord => ({ kind: 'script', name, sha256: sha256(source) }));
  for (const [name, declaration] of commands) records.push({ kind: 'command', name, sha256: sha256(canonicalJson(declaration)) });
  const order = (record: UnsafeDeclarationRecord): string => `${record.kind}:${record.name}`;
  return { unsafeFeatures, unsafeDeclarations: records.sort((left, right) => (order(left) < order(right) ? -1 : 1)) };
}

// The service-call responses first, as before, then any other unpinned inputs, sorted and once
// each. A run with none of the others has exactly the list it always had, so its hash is unchanged.
function nonHermeticInputs(callsServices: boolean, others: readonly string[]): readonly string[] {
  const rest = [...new Set(others)].filter((input) => input !== SERVICE_CALLS_INPUT).sort();
  return callsServices ? [SERVICE_CALLS_INPUT, ...rest] : rest;
}

// The project as its hash covers it: everything but the evidence-mode and planner sections, which a
// plan run never reads, so turning either on leaves a plan run's manifest unchanged; and where a
// trusted project was read from, so the same file has the same hash, parsed or loaded as trusted.
type HashedProject = Project & { readonly provenance?: Provenance };
// Each section the hash leaves out, as nothing, which canonical JSON leaves out. A key the project
// does not have fails to compile.
const LEFT_OUT_OF_THE_HASH = {
  evidenceMode: undefined, planner: undefined, provenance: undefined,
} satisfies Partial<Record<keyof HashedProject, undefined>>;

export function projectHash(project: HashedProject): string {
  return sha256(canonicalJson({ ...project, ...LEFT_OUT_OF_THE_HASH }));
}

// The manifest fields a run's pins give, with the project's hash and limits.
function pinnedFields(pins: RunPins, project: Project): Partial<PlanRunManifest> {
  return {
    projectHash: projectHash(project),
    versions: { ...pins.versions, packs: [...pins.versions.packs].sort() },
    redactor: pins.redactor,
    limits: sha256(canonicalJson(project.limits)),
    baselinesHash: pins.baselinesHash,
    rulesetHash: pins.rulesetHash,
    ...(pins.imageDigest === undefined ? {} : { imageDigest: pins.imageDigest }),
    fontsSha256: pins.fontsSha256,
    commit: pins.commit,
  };
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
  // The sha256 of the browser executable core hashed before launching it.
  readonly executableSha256?: string;
  // The run's pins and its project. Without pins, none of the fields they give is recorded.
  readonly pins?: { readonly pins: RunPins; readonly project: Project };
  // True when the project records the replies of the run's calls and commands.
  readonly recordsReplies?: boolean;
}): PlanRunManifest {
  const pinned = inputs.pins === undefined ? undefined : pinnedFields(inputs.pins.pins, inputs.pins.project);
  const { id, version, protocol, cannotPin } = inputs.adapter;
  const unpinned = [
    ...(inputs.adapter.cannotPin ?? []), ...(inputs.unpinned ?? []),
    ...(inputs.pins !== undefined && inputs.pins.pins.imageDigest === undefined ? [RUN_IMAGE_INPUT] : []),
  ];
  const needsReplies = inputs.callsServices === true || unpinned.includes(DATABASE_COMMANDS_INPUT);
  const recorded = inputs.recordsReplies === true && needsReplies ? [RECORDED_REPLIES_INPUT] : [];
  const secrets = inputs.secrets === undefined || inputs.secrets.length === 0
    ? {}
    : { secrets: [...inputs.secrets].sort((left, right) => compareText(left.name, right.name)) };
  return {
    schema: schemaId('run-manifest', 1),
    engineVersion: ENGINE_VERSION,
    planHash: planHash(inputs.plan),
    target: inputs.target,
    adapter: { id, version, protocol, ...(cannotPin === undefined ? {} : { cannotPin }) },
    browser: inputs.browser,
    seeds: { random: inputs.seed },
    clock: { fixedTimeMilliseconds: inputs.fixedTimeMilliseconds },
    fixtures: [...inputs.fixtures].sort((left, right) => (left.path < right.path ? -1 : 1)),
    host: inputs.host,
    nonHermeticInputs: nonHermeticInputs(inputs.callsServices === true, [...unpinned, ...recorded]),
    ...secrets,
    ...(inputs.storageState === undefined ? {} : { storageState: inputs.storageState }),
    ...(inputs.unsafe === undefined ? {} : inputs.unsafe),
    ...(inputs.responseRewrites === undefined || inputs.responseRewrites.length === 0 ? {} : {
      responseRewrites: inputs.responseRewrites.map((applied) => ({ origin: applied.origin, name: applied.name }))
        .sort((left, right) => (left.origin === right.origin ? compareText(left.name, right.name) : compareText(left.origin, right.origin))),
    }),
    ...(inputs.executableSha256 === undefined ? {} : { executableSha256: inputs.executableSha256 }),
    ...pinned,
  };
}

export const manifestHash = (manifest: RunManifest): string => sha256(canonicalJson(manifest));
