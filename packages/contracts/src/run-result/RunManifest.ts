// The run manifest: every input that decides a run's result, so a run can be replayed and compared.
// The engine builds and hashes it.
import type { AdapterInfo } from "../browser-driver.ts";
import type { ImageDigest, SuiteName } from "../evidence-mode.ts";
import type { AppliedRewrite } from "../isolated-runner.ts";
import type { SecretName } from "../plan.ts";
import type { RedactionMode } from "../secret.ts";
import type { Target } from "../target.ts";
import type { UnsafeFeature } from "../unsafe-plan-features.ts";

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
export type UnsafeDeclarationRecord = {
    readonly kind: "script" | "command";
    readonly name: string;
    readonly sha256: string;
};

// The versions of what decides a run besides the engine and the adapter: Revisum itself (the cli
// package), the ACT rule set, axe-core, Node, and each installed pack as "name@version", sorted.
export type RunVersions = {
    readonly core: string;
    readonly act: string;
    readonly axe: string;
    readonly node: string;
    readonly packs: readonly string[];
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
    readonly selfReported: {
        readonly playwrightVersion: string | null;
        readonly browsers: readonly string[];
    };
};

// What every run's manifest holds, a plan run's or an evidence run's.
type ManifestBasis = {
    readonly schema: string;
    readonly engineVersion: string;
    // For an evidence run, which has no plan, the sha256 of the suite's declaration, which decides
    // what ran.
    readonly planHash: string;
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
    // The sha256 of the browser executable core launched, hashed by core itself before the browser
    // opened, never taken from what the adapter reports. Present only for an adapter that reports
    // its build; a run on any other has none, so its manifest and hash stay as they were.
    readonly executableSha256?: string;
    // Present only when the run was given its pins, each copied from them, so a run without pins
    // has a manifest, and a hash, exactly as before. `projectHash` is the sha256 of the canonical
    // project without its evidence-mode and planner sections, which a plan run never reads;
    // `limits` is the sha256 of the project's run limits.
    readonly projectHash?: string;
    readonly versions?: RunVersions;
    readonly redactor?: string;
    readonly limits?: string;
    readonly baselinesHash?: string;
    readonly rulesetHash?: string;
    readonly imageDigest?: string;
    readonly fontsSha256?: string;
    readonly commit?: string | null;
};

// A plan run's manifest: the target, adapter and browser it ran on, and no evidence record.
export type PlanRunManifest = ManifestBasis & {
    readonly target: Target;
    readonly adapter: AdapterInfo;
    readonly browser: { readonly name: string; readonly version: string };
    readonly evidence?: never;
};

// An evidence run's manifest: its evidence record, and no target, adapter or browser of its own,
// since the suite's own browser is self-reported in that record.
export type EvidenceRunManifest = ManifestBasis & {
    readonly target?: never;
    readonly adapter?: never;
    readonly browser?: never;
    readonly evidence: EvidenceManifestRecord;
};

export type RunManifest = PlanRunManifest | EvidenceRunManifest;
