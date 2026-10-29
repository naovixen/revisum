// Shared setup for the real-container tests (npm run check:containers). These need Docker: on
// the founder's machine through Docker Desktop, and in CI's own container step. They start only
// containers from the run image, built from runner/image/Dockerfile, and remove every container
// and network they create. See docs/decisions/container-tests.md.
//
// The host's environment is seeded with fake credentials before a run starts, so a runner that
// passed any of the host's environment into the container would be caught.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { EgressPolicy, ImageDigest, Runner, RunnerHandle } from '@revisum/contracts';
import { dockerCliEngine, dockerRunner, prepareRunImage, type ExecOutcome, type RunnerLogEntry } from '@revisum/runner';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { egressPolicy } from '../unit/runner/runner-examples.ts';

// Fake credentials of the kinds a developer's or CI's environment holds: publishing, cloud and
// package-registry. None is real; each value is unique so it can be searched for.
export const SEEDED_CREDENTIALS: Readonly<Record<string, string>> = {
  GITHUB_TOKEN: 'ghp_fakeTokenSeededForIsolationTests',
  AWS_SECRET_ACCESS_KEY: 'fakeAwsSecretSeededForIsolationTests',
  NPM_TOKEN: 'npm_fakeTokenSeededForIsolationTests',
};

// Fails, never skips, when Docker cannot be reached: these tests exist to show isolation.
export function requireDocker(): void {
  const version = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', windowsHide: true });
  assert.equal(version.status, 0, `npm run check:containers needs a running Docker: ${version.stderr}`);
}

// The ids of every container (running or not) or every network Docker knows of now.
export function dockerIds(kind: 'containers' | 'networks'): ReadonlySet<string> {
  const words = kind === 'containers' ? ['ps', '--all', '--quiet', '--no-trunc'] : ['network', 'ls', '--quiet', '--no-trunc'];
  const listed = spawnSync('docker', words, { encoding: 'utf8', windowsHide: true });
  assert.equal(listed.status, 0, listed.stderr);
  return new Set(listed.stdout.split(/\s+/).filter((id) => id !== ''));
}

export const newIds = (before: ReadonlySet<string>, after: ReadonlySet<string>): readonly string[] => [...after].filter((id) => !before.has(id));

// The run image's id, built or reused by the runner, so every test starts from the pinned image.
export async function pinnedRunImage(): Promise<ImageDigest> {
  requireDocker();
  const prepared = await prepareRunImage({ repositoryRoot: REPOSITORY_ROOT });
  assert.ok(prepared.ok, `the run image is prepared: ${prepared.ok ? '' : JSON.stringify(prepared.error)}`);
  return prepared.value.id;
}

export type IsolatedRun = {
  readonly runner: Runner;
  readonly handle: RunnerHandle;
  readonly logged: readonly RunnerLogEntry[];
  stop(): Promise<void>;
};

export type IsolatedRunOptions = {
  readonly policy?: EgressPolicy;
  // Repository-relative folders the run gets as read-only inputs, beside packages, node_modules and .browsers.
  readonly inputs?: readonly string[];
};

// Starts a run from the pinned image with the host's environment seeded with fake credentials,
// and restores the host's environment when the run stops.
export async function startIsolatedRun(options: IsolatedRunOptions = {}): Promise<IsolatedRun> {
  const image = await pinnedRunImage();
  const previous = new Map(Object.keys(SEEDED_CREDENTIALS).map((name) => [name, process.env[name]] as const));
  for (const [name, value] of Object.entries(SEEDED_CREDENTIALS)) process.env[name] = value;
  const logged: RunnerLogEntry[] = [];
  const runner = dockerRunner({
    engine: dockerCliEngine(), repositoryRoot: REPOSITORY_ROOT, inputs: options.inputs ?? [], log: (entry) => { logged.push(entry); },
  });
  const restore = (): void => {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  };
  const started = await runner.start(image, options.policy ?? egressPolicy({ allowOrigins: [] }));
  if (!started.ok) restore();
  assert.ok(started.ok, `the isolated run starts: ${started.ok ? '' : JSON.stringify(started.error)} ${JSON.stringify(logged)}`);
  const handle = started.value;
  return {
    runner, handle, logged,
    async stop() {
      try { await handle.stop(); } finally { restore(); }
    },
  };
}

// Runs a Node script inside the run container, without a shell, and returns what it printed.
export async function nodeInside(handle: RunnerHandle, script: string): Promise<ExecOutcome> {
  return handle.exec(['node', '-e', script]);
}

// Runs a Node script inside the run container that prints one JSON value on its last line.
export async function jsonInside(handle: RunnerHandle, script: string): Promise<unknown> {
  const outcome = await nodeInside(handle, script);
  assert.equal(outcome.exitCode, 0, `the script inside the container failed: ${outcome.stderr}`);
  const lines = outcome.stdout.trim().split('\n');
  return JSON.parse(lines.at(-1) ?? 'null');
}
