// Shared setup for the workload runner's real-container tests (npm run check:containers): the
// fixture workload image, built from fixtures/evidence-workload/ on top of Revisum's run image;
// the workload runner on the Docker engine, with this repository as the checkout; and a declared
// suite that runs the fixture suite with the Playwright Test stand-in.
// The host's environment is seeded with fake credentials while a workload runs, so a runner that
// let any of it through would be caught.
// See docs/specs/SPEC-35-evidence-mode.md and docs/decisions/container-tests.md.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT, type WorkloadOutcome, type WorkloadRunner } from '@revisum/contracts';
import { environmentSecretStore, type Project, type RunResult } from '@revisum/engine';
import { runSuite } from '@revisum/cli';
import { RUN_IMAGE_TAG, dockerCliEngine, runDocker, workloadRunner, type ContainerEngine } from '@revisum/runner';
import { FIXTURES, REPOSITORY_ROOT } from '../support/repository.ts';
import { DECLARED_SECRET, SUITE_NAME, evidenceModeInput, parsedProject, projectFileWithEvidence, suiteInput } from '../unit/engine/evidence-examples.ts';
import { printed, withSeededHost, workloadRequest, type RequestFields, type RunnerLog } from '../unit/runner/workload-examples.ts';
import { pinnedRunImage } from './isolated-run.ts';

export const WORKLOAD_IMAGE_TAG = `${PRODUCT.name}-evidence-workload`;
// The fixture suite's folder, relative to the checkout.
export const SUITE_FOLDER = 'fixtures/evidence-workload/suite';
const BUILD_TIMEOUT_MILLISECONDS = 600_000;

// The fixture workload image's id, built from the run image (which is built or reused first).
export async function fixtureWorkloadImage(): Promise<string> {
  await pinnedRunImage();
  const built = await runDocker([
    'build', '--tag', WORKLOAD_IMAGE_TAG, '--build-arg', `RUN_IMAGE=${RUN_IMAGE_TAG}`, join(FIXTURES, 'evidence-workload'),
  ], BUILD_TIMEOUT_MILLISECONDS);
  assert.equal(built.status, 0, `the fixture workload image did not build: ${built.stderr.slice(-2000)}`);
  const id = await dockerCliEngine().imageId(WORKLOAD_IMAGE_TAG);
  assert.ok(id !== null, 'the fixture workload image has no id');
  return id;
}

// The names the image itself sets in its environment, such as PATH and NODE_VERSION: the team's
// own, not the host's.
export async function imageEnvironmentNames(imageId: string): Promise<readonly string[]> {
  const inspected = await runDocker(['image', 'inspect', '--format', '{{json .Config.Env}}', imageId]);
  assert.equal(inspected.status, 0, inspected.stderr);
  const entries: unknown = JSON.parse(inspected.stdout.trim());
  assert.ok(Array.isArray(entries));
  return entries.map((entry) => String(entry).split('=')[0] ?? '');
}

export type RealWorkloadRunner = { readonly runner: WorkloadRunner; readonly logged: readonly RunnerLog[] };

export function realWorkloadRunner(engine: ContainerEngine = dockerCliEngine()): RealWorkloadRunner {
  const logged: RunnerLog[] = [];
  const runner = workloadRunner({ engine, repositoryRoot: REPOSITORY_ROOT, checkout: REPOSITORY_ROOT, log: (entry: RunnerLog) => { logged.push(entry); } });
  return { runner, logged };
}

export const outputFolder = (): string => mkdtempSync(join(tmpdir(), 'workload-output-'));
export const filesIn = (folder: string): readonly string[] => readdirSync(folder, { recursive: true }).map(String);

// Runs one command in the fixture image, from the fixture suite's folder, with the host seeded.
export async function runInWorkload(image: string, fields: RequestFields): Promise<WorkloadOutcome> {
  const { runner, logged } = realWorkloadRunner();
  const outcome = await withSeededHost(() => runner.run(workloadRequest({ image, workingDirectory: SUITE_FOLDER, ...fields })));
  assert.ok(outcome.ok, `the workload did not run: ${JSON.stringify(outcome)} ${JSON.stringify(logged)}`);
  return outcome.value;
}

// The JSON value a command printed on its last line of standard output.
export function printedJson(outcome: WorkloadOutcome): unknown {
  const lines = printed(outcome.stdout).trim().split('\n');
  return JSON.parse(lines.at(-1) ?? 'null');
}

// A project declaring the fixture suite: the stand-in as its command, the declared secret in its
// environment, and no setup command, since the image has nothing to install.
export function fixtureSuiteProject(image: string): Project {
  const suite = suiteInput({
    image, command: ['playwright', 'test'], workingDirectory: SUITE_FOLDER, paths: [`${SUITE_FOLDER}/**`], projects: ['chromium'],
    environment: { [DECLARED_SECRET]: { secretName: DECLARED_SECRET } },
  });
  Reflect.deleteProperty(suite, 'setupCommand');
  return parsedProject(projectFileWithEvidence(evidenceModeInput([suite])));
}

export type RealSuiteRun = { readonly result: RunResult; readonly outputDirectory: string };

// Runs the fixture suite through runSuite on the given engine, with the declared secret's value.
export async function runFixtureSuite(image: string, secretValue: string, engine?: ContainerEngine): Promise<RealSuiteRun> {
  const outputDirectory = outputFolder();
  const { runner } = realWorkloadRunner(engine);
  const result = await withSeededHost(() => runSuite(fixtureSuiteProject(image), SUITE_NAME, {
    workload: runner, secrets: environmentSecretStore({ [DECLARED_SECRET]: secretValue }), checkout: REPOSITORY_ROOT, outputDirectory,
  }));
  return { result, outputDirectory };
}
