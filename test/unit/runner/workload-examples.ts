// Shared examples for the workload runner's tests: the team's image, a workload request, and the
// runner built on a container engine.
//
// The workload runner (SPEC-35, extending SPEC-07) starts a team's own image, pinned by digest,
// behind the same egress proxy and hardening as the isolated runner. The spec names
// WorkloadRunner, WorkloadRequest and WorkloadOutcome. The shapes it leaves open are settled
// here only, so changing one changes one place:
//   - workloadRunner(options) in runner builds it, with the options of dockerRunner: the container
//     engine, repositoryRoot (Revisum's own files: the proxy's code and the seccomp profile), and
//     `checkout`, the folder of the repository under test that is mounted read-only;
//   - run() fails with the bare WorkloadErrorCode, as the spec's Result type gives it; errorCode()
//     below also reads a { code } error, so either form passes;
//   - WorkloadOutcome's stdout and stderr are each { bytes, truncated }.
// See docs/specs/SPEC-35-evidence-mode.md.
import { Buffer } from 'node:buffer';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Result, Secret, WorkloadOutcome, WorkloadRequest, WorkloadRunner } from '@revisum/contracts';
import { RUN_IMAGE_TAG, workloadRunner, type ContainerEngine, type ContainerOptions } from '@revisum/runner';
import { REPOSITORY_ROOT } from '../../support/repository.ts';
import { PINNED_IMAGE_ID, egressPolicy, imageDigest } from './runner-examples.ts';

// The team's workload image, and another image id that a moved tag could point to.
export const TEAM_IMAGE_ID = `sha256:${'c'.repeat(64)}`;
export const OTHER_TEAM_IMAGE_ID = `sha256:${'d'.repeat(64)}`;

// The image ids the fake engine answers with on a host where both images are present.
export const PRESENT_IMAGES: Readonly<Record<string, string | null>> = { [RUN_IMAGE_TAG]: PINNED_IMAGE_ID, [TEAM_IMAGE_ID]: TEAM_IMAGE_ID };

export const SUITE_COMMAND = ['npx', 'playwright', 'test', '--retries=0', '--reporter=json', '--trace=on', '--project=chromium'];
export const DECLARED_LITERAL = { name: 'BASE_URL', value: 'http://127.0.0.1:4173' } as const;
export const DECLARED_SECRET_NAME = 'SHOP_API_TOKEN';

export const outputFolder = (): string => mkdtempSync(join(tmpdir(), 'workload-output-'));

export type RequestFields = {
  readonly argv?: readonly string[];
  readonly environment?: readonly { readonly name: string; readonly value: string | Secret }[];
  readonly timeoutMilliseconds?: number;
  readonly outputDirectory?: string;
  readonly workingDirectory?: string;
  readonly image?: string;
};

export function workloadRequest(fields: RequestFields = {}): WorkloadRequest {
  return {
    image: imageDigest(fields.image ?? TEAM_IMAGE_ID),
    argv: fields.argv ?? SUITE_COMMAND,
    workingDirectory: fields.workingDirectory ?? 'apps/web',
    environment: fields.environment ?? [DECLARED_LITERAL],
    policy: egressPolicy({ allowOrigins: [] }),
    timeoutMilliseconds: fields.timeoutMilliseconds ?? 60_000,
    outputDirectory: fields.outputDirectory ?? outputFolder(),
  };
}

export type RunnerLog = { readonly code: string; readonly detail: string };

export function runnerOn(engine: ContainerEngine, checkout: string = REPOSITORY_ROOT): { readonly runner: WorkloadRunner; readonly logged: RunnerLog[] } {
  const logged: RunnerLog[] = [];
  const runner = workloadRunner({ engine, repositoryRoot: REPOSITORY_ROOT, checkout, log: (entry: RunnerLog) => { logged.push(entry); } });
  return { runner, logged };
}

// The failure's code, whether the runner gives the bare code or a { code } object.
export function errorCode(result: Result<WorkloadOutcome, unknown>): string | null {
  if (result.ok) return null;
  const error: unknown = result.error;
  if (typeof error === 'string') return error;
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : JSON.stringify(error);
}

// The containers the runner started from the team's image.
export const teamContainers = (started: readonly ContainerOptions[], image: string = TEAM_IMAGE_ID): readonly ContainerOptions[] =>
  started.filter((options) => options.image === image);

// What a process printed, as text.
export const printed = (output: { readonly bytes: Uint8Array }): string => Buffer.from(output.bytes).toString('utf8');

// The fake credentials the host's environment is seeded with while a run starts, so a runner that
// let the host's environment through would be caught.
export const HOST_CREDENTIALS: Readonly<Record<string, string>> = {
  GITHUB_TOKEN: 'ghp_fakeTokenSeededForWorkloadTests',
  GITHUB_ACTIONS: 'true',
  AWS_SECRET_ACCESS_KEY: 'fakeAwsSecretSeededForWorkloadTests',
  NPM_TOKEN: 'npm_fakeTokenSeededForWorkloadTests',
};

// The seeded values distinctive enough to search for in what reached a container.
export const DISTINCTIVE_HOST_VALUES: readonly string[] = Object.values(HOST_CREDENTIALS).filter((value) => value.length >= 16);

// Runs `body` with the host's environment seeded with HOST_CREDENTIALS, then restores it.
export async function withSeededHost<Value>(body: () => Promise<Value>): Promise<Value> {
  const previous = new Map(Object.keys(HOST_CREDENTIALS).map((name) => [name, process.env[name]] as const));
  for (const [name, value] of Object.entries(HOST_CREDENTIALS)) process.env[name] = value;
  try {
    return await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

// The names Revisum may set for itself: the reserved names of the suite declaration, which a
// declaration can never use, except the GITHUB_* names, which no workload ever gets.
export const isRevisumOwnName = (name: string): boolean =>
  !name.startsWith('GITHUB_') && (['PATH', 'HOME', 'NODE_OPTIONS', 'CI', 'NODE_USE_ENV_PROXY'].includes(name)
    || /^(PLAYWRIGHT_|PW_)/.test(name) || /_PROXY$/i.test(name));
