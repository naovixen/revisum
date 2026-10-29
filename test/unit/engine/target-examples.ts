// What the target matrix and lock tests share: projects built from raw JSON through the project
// parser, fake browser drivers that count every call and never launch a browser, and fake browser
// builds that are real files on disk, so a build's sha256 is computed from real bytes.
// See docs/specs/SPEC-05-target-matrix-and-lock.md.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultRedactor, failure, parseProject, planParser, run, sha256, success,
  type BrowserBuild, type BrowserDriver, type BuildFailure, type Project, type Result, type RunInputs, type RunResult, type Target,
  type TrustedProject, type Unavailable,
} from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock, type MemoryArtifactStore } from '../../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../../support/policy-clearance.ts';
import { ORIGIN, signupPlan, testProjectInput, withValue, type JsonRecord } from './plan-examples.ts';

// One matrix entry as a person writes it in project.json; `extra` adds or replaces fields.
export const targetInput = (id: string, adapter: string, engine: string, device: string, extra: JsonRecord = {}): JsonRecord => ({
  id, adapter, engine, device, locale: 'de-DE', timezone: 'Asia/Tokyo', colorScheme: 'dark', reducedMotion: 'reduce', ...extra,
});

export const projectFileWith = (matrix: readonly JsonRecord[]): JsonRecord => testProjectInput({}, { matrix });

export function projectWith(matrix: readonly JsonRecord[]): Project {
  const parsed = parseProject(projectFileWith(matrix));
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

export const trustedProjectWith = (matrix: readonly JsonRecord[]): Promise<TrustedProject> => trustedProjectFrom(projectFileWith(matrix));

// The target with this id in the project's matrix; a missing one is a broken test.
export function targetOf(project: Project | TrustedProject, id: string): Target {
  const found = project.matrix.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no target ${id} in the test project`);
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
  const folder = mkdtempSync(join(tmpdir(), 'revisum-browser-build-'));
  const executablePath = join(folder, 'browser-executable');
  let bytes = new TextEncoder().encode(text);
  writeFileSync(executablePath, bytes);
  return {
    executablePath,
    replaceBytes(replacement) { bytes = new TextEncoder().encode(replacement); writeFileSync(executablePath, bytes); },
    sha256: () => sha256(bytes),
    remove: () => rmSync(folder, { recursive: true, force: true }),
  };
}

export type BuildOutcome = Result<BrowserBuild, BuildFailure>;
export type DriverCalls = { supports: number; open: number; build: number };
export type FakeDriver = BrowserDriver & { readonly calls: DriverCalls };

export type FakeDriverOptions = {
  // The refusal for a target the fake does not support; null when it supports it.
  readonly refuse?: (target: Target) => Unavailable | null;
  // What `build` reports, asked afresh on every call. Absent: the driver has no `build`.
  readonly build?: (target: Target) => BuildOutcome;
};

// The optional build port, typed against BrowserDriver itself, so a driver port without it fails to compile.
const withBuild = (build: NonNullable<BrowserDriver['build']>): Pick<BrowserDriver, 'build'> => ({ build });

// A driver that counts every call. Its `open` never launches a browser: it always reports
// launch-failed, so a run that reaches it ends TargetUnavailable with that reason.
export function fakeDriver(id: string, options: FakeDriverOptions = {}): FakeDriver {
  const calls: DriverCalls = { supports: 0, open: 0, build: 0 };
  const reportBuild = options.build;
  const driver: FakeDriver = {
    calls,
    info: { id, version: 'fake', protocol: 'none' },
    supports(target) {
      calls.supports++;
      const refusal = options.refuse?.(target) ?? null;
      return refusal === null ? success(true) : failure(refusal);
    },
    async open() {
      calls.open++;
      return failure({ reason: 'launch-failed', detail: 'the fake driver never launches a browser' });
    },
    ...(reportBuild === undefined ? {} : withBuild(async (target) => { calls.build++; return reportBuild(target); })),
  };
  return driver;
}

export const totalCalls = (driver: FakeDriver): number => driver.calls.supports + driver.calls.open + driver.calls.build;

// A build outcome naming the fake executable at the given version.
export const builtAt = (version: string, build: FakeBrowserBuild): BuildOutcome => success({ version, executablePath: build.executablePath });

// The run input that carries the lockfile's entries, typed against RunInputs itself.
const pinnedTo = (lockEntries: NonNullable<RunInputs['lockEntries']>): Pick<RunInputs, 'lockEntries'> => ({ lockEntries });

export type TargetRun = { readonly result: RunResult; readonly store: MemoryArtifactStore };

// Runs the sign-up plan, declaring `planTargets`, on one target: the plan is parsed and authorised
// under `planProject` and run under `runProject` (the same project unless a test needs them apart).
export async function runOnTarget(options: {
  readonly runProject: Project;
  readonly planProject?: Project;
  readonly trusted: TrustedProject;
  readonly planTargets: readonly string[];
  readonly target: Target;
  readonly drivers: ReadonlyMap<string, BrowserDriver>;
  readonly lockEntries?: NonNullable<RunInputs['lockEntries']>;
}): Promise<TargetRun> {
  const parsed = planParser(options.planProject ?? options.runProject)(withValue(signupPlan(), ['targets'], [...options.planTargets]));
  if (!parsed.ok) throw new Error(`bad test plan: ${JSON.stringify(parsed.error)}`);
  const store = memoryArtifactStore();
  const result = await run({
    plan: authorise(parsed.value, options.trusted), project: options.runProject, targetId: options.target.id,
    baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() },
    ...(options.lockEntries === undefined ? {} : pinnedTo(options.lockEntries)),
  }, {
    drivers: options.drivers, clock: systemClock, artifacts: store,
    redactor: defaultRedactor(), audit: memoryEventSink(), events: memoryRunEventSink(),
  });
  return { result, store };
}
