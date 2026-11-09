// What the target matrix and lock tests share: projects built from raw JSON through the project
// parser, fake browser drivers that count every call and never launch a browser, and fake browser
// builds that are real files on disk, so a build's sha256 is computed from real bytes.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
    UntrustedRunOutcomeKind,
    createRunService,
    failure,
    parseProject,
    planParser,
    policyGate,
    sha256,
    success,
    type BrowserBuild,
    type BrowserDriver,
    type BuildFailure,
    type Plan,
    type Project,
    type Result,
    type RunClearance,
    type RunInputs,
    type RunResult,
    type Target,
    type TargetId,
    type TrustedProject,
    type Unavailable,
} from "@revisum/engine";
import { type MemoryArtifactStore } from "../../../../support/builders/MemoryEventSink.ts";
import { baseUrlOf, clearRun, trustedProjectFrom } from "../../../../support/builders/ClearRun.ts";
import {
    ORIGIN,
    signupPlan,
    testProjectInput,
    withValue,
    type JsonRecord,
} from "../../plan/examples/GoldenPlan.ts";
import { fakeArtifactStore } from "#test-support/fakes/ports/FakeArtifactStore.ts";
import { fakeEventSink } from "#test-support/fakes/ports/FakeEventSink.ts";
import {
    fakeDriverNeverLaunching,
    type FakeDriver,
} from "#test-support/fakes/session/FakeDriver.ts";
import { fakePorts } from "#test-support/fakes/FakePorts.ts";

// One matrix entry as a person writes it in project.json; `extra` adds or replaces fields.
export const targetInput = (
    id: string,
    adapter: string,
    engine: string,
    device: string,
    extra: JsonRecord = {},
): JsonRecord => ({
    id,
    adapter,
    engine,
    device,
    locale: "de-DE",
    timezone: "Asia/Tokyo",
    colorScheme: "dark",
    reducedMotion: "reduce",
    ...extra,
});

export const projectFileWith = (matrix: readonly JsonRecord[]): JsonRecord =>
    testProjectInput({}, { matrix });

export function projectWith(matrix: readonly JsonRecord[]): Project {
    const parsed = parseProject(projectFileWith(matrix));
    if (!parsed.ok) {
        throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
    }
    return parsed.value;
}

export const trustedProjectWith = (matrix: readonly JsonRecord[]): Promise<TrustedProject> =>
    trustedProjectFrom(projectFileWith(matrix));

// The target with this id in the project's matrix; a missing one is a broken test.
export function targetOf(project: Project | TrustedProject, id: string): Target {
    const found = project.matrix.find((candidate) => candidate.id === id);
    if (found === undefined) {
        throw new Error(`no target ${id} in the test project`);
    }
    return found;
}

// A browser executable that is only a file of known bytes: hashing it is real, and nothing runs it.
export type FakeBrowserBuild = {
    readonly executablePath: string;
    // Replaces the executable's bytes, as a re-download or an upgrade in place would.
    replaceBytes(text: string): void;
    sha256(): string;
    remove(): void;
};

export function fakeBrowserBuild(text: string): FakeBrowserBuild {
    const folder = mkdtempSync(join(tmpdir(), "revisum-browser-build-"));
    const executablePath = join(folder, "browser-executable");
    let bytes = new TextEncoder().encode(text);
    writeFileSync(executablePath, bytes);
    return {
        executablePath,
        replaceBytes(replacement) {
            bytes = new TextEncoder().encode(replacement);
            writeFileSync(executablePath, bytes);
        },
        sha256: () => sha256(bytes),
        remove: () => rmSync(folder, { recursive: true, force: true }),
    };
}

export type BuildOutcome = Result<BrowserBuild, BuildFailure>;

export type TargetDriverOptions = {
    // The refusal for a target the fake does not support; null when it supports it.
    readonly refuse?: (target: Target) => Unavailable | null;
    // What `build` reports, asked afresh on every call. Absent: the driver has no `build`.
    readonly build?: (target: Target) => BuildOutcome;
};

// A driver under its own id whose `open` never launches a browser: it always reports launch-failed,
// so a run that reaches it ends TargetUnavailable with that reason.
export function targetDriver(id: string, options: TargetDriverOptions = {}): FakeDriver {
    const reportBuild = options.build;
    const overrides: Partial<BrowserDriver> = {
        info: { id, version: "fake", protocol: "none" },
        supports(target) {
            const refusal = options.refuse?.(target) ?? null;
            return refusal === null ? success(true) : failure(refusal);
        },
    };
    return reportBuild === undefined
        ? fakeDriverNeverLaunching(overrides, ["build"])
        : fakeDriverNeverLaunching({
              ...overrides,
              build: (target) => Promise.resolve(reportBuild(target)),
          });
}

// A build outcome naming the fake executable at the given version.
export const builtAt = (version: string, build: FakeBrowserBuild): BuildOutcome =>
    success({ version, executablePath: build.executablePath });

// The run input that carries the lockfile's entries, typed against RunInputs itself.
const pinnedTo = (
    lockEntries: NonNullable<RunInputs["lockEntries"]>,
): Pick<RunInputs, "lockEntries"> => ({ lockEntries });

export type TargetRun = { readonly result: RunResult; readonly store: MemoryArtifactStore };

// Runs the sign-up plan, declaring `planTargets`, on one target: the plan is parsed under
// `planProject`, and cleared and run under the trusted project (the same file unless a test needs
// them apart).
export async function runOnTarget(options: {
    readonly planProject: Project;
    readonly trusted: TrustedProject;
    readonly planTargets: readonly string[];
    readonly target: Target;
    readonly drivers: ReadonlyMap<string, BrowserDriver>;
    readonly lockEntries?: NonNullable<RunInputs["lockEntries"]>;
}): Promise<TargetRun> {
    const store = fakeArtifactStore();
    const result = await createRunService(
        fakePorts({ drivers: options.drivers, artifacts: store }),
    ).run(
        clearRun(
            signupPlanOn(options.planProject, options.planTargets),
            options.trusted,
            options.target.id,
        ),
        {
            baseUrl: baseUrlOf(ORIGIN),
            seed: 42,
            fixedTimeMilliseconds: 0,
            fixtures: [],
            host: { platform: platform(), arch: arch() },
            ...(options.lockEntries === undefined ? {} : pinnedTo(options.lockEntries)),
        },
    );
    return { result, store };
}

// The sign-up plan, declaring `planTargets`, parsed under `planProject`.
export function signupPlanOn(planProject: Project, planTargets: readonly string[]): Plan {
    const parsed = planParser(planProject)(withValue(signupPlan(), ["targets"], [...planTargets]));
    if (!parsed.ok) {
        throw new Error(`bad test plan: ${JSON.stringify(parsed.error)}`);
    }
    return parsed.value;
}

// What the trusted project's policy gate gives the sign-up plan, declaring `planTargets` and parsed
// under `planProject`, for one target id.
export const clearanceOn = (options: {
    readonly planProject: Project;
    readonly trusted: TrustedProject;
    readonly planTargets: readonly string[];
    readonly targetId: TargetId;
}): RunClearance =>
    policyGate({ project: options.trusted, events: fakeEventSink() }).clear(
        signupPlanOn(options.planProject, options.planTargets),
        options.targetId,
    );

export type UntrustedRuns = {
    readonly results: readonly RunResult[];
    readonly store: MemoryArtifactStore;
};

// Runs the sign-up plan, declaring `planTargets`, as an untrusted plan from outside: parsed under
// `planProject`, then cleared and run under the trusted project on every target it names.
export async function runUntrustedOn(options: {
    readonly planProject: Project;
    readonly trusted: TrustedProject;
    readonly planTargets: readonly string[];
    readonly drivers: ReadonlyMap<string, BrowserDriver>;
}): Promise<UntrustedRuns> {
    const store = fakeArtifactStore();
    const outcome = await createRunService(
        fakePorts({ drivers: options.drivers, artifacts: store }),
    ).runUntrusted(
        withValue(signupPlan(), ["targets"], [...options.planTargets]),
        planParser(options.planProject),
        {
            project: options.trusted,
            baseUrl: baseUrlOf(ORIGIN),
            seed: 42,
            fixedTimeMilliseconds: 0,
            fixtures: [],
            host: { platform: platform(), arch: arch() },
        },
    );
    if (outcome.kind !== UntrustedRunOutcomeKind.Ran) {
        throw new Error(`the test plan did not run: ${JSON.stringify(outcome)}`);
    }
    return { results: outcome.results, store };
}
