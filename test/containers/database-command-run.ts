// Shared setup for the database commands' real-container tests (npm run check:containers): the
// fixture image, built from fixtures/database-command-workload/ on top of Revisum's run image; two
// TCP services on Docker's default bridge, standing for the declared database and another declared
// service, each declared by its bridge address; and a plan run through run() with cli's
// DatabaseCommandRunner over runner's real workload runner, on a driver that needs no browser.
//
// What these tests assume about shapes the spec leaves open:
//   - cli exports databaseCommandRunner(options), which wires runner's WorkloadRunner to the
//     DatabaseCommandRunner port. It is looked up by name, so this file compiles before it exists.
//     Its options hold `workload` and the project's declared `services`;
//   - the port answers Result<WorkloadOutcome, WorkloadErrorCode>, as the engine tests assume
//     (test/unit/engine/database-command-examples.ts), and run() takes it in its ports, as
//     `databaseCommands`, beside `services`;
//   - a service declared by an IP address on the default bridge is reached at that address and
//     port; the run's proxy container already joins that bridge. Nothing is published on the host,
//     so the tests run the same on Docker Desktop and on Linux CI.
// The host's environment is seeded with fake credentials while a command runs.
// See docs/specs/SPEC-36-unsafe-plan-features.md ("Database commands" under "Milestone").
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import * as cliPackage from '@revisum/cli';
import { PRODUCT, type DeclaredService, type Result, type WorkloadErrorCode, type WorkloadOutcome, type WorkloadRunner } from '@revisum/contracts';
import { defaultRedactor, environmentSecretStore, parseProject, planParser, run, type Project, type RunResult } from '@revisum/engine';
import { RUN_IMAGE_TAG, dockerCliEngine, runDocker } from '@revisum/runner';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { FIXTURES } from '../support/repository.ts';
import { TEST_SERVICE, TEST_SERVICE_SECRET_NAMES, testProjectInput, type JsonRecord } from '../unit/engine/plan-examples.ts';
import { DEFAULT_CLOCK_START, DEFAULT_SEED, accepted, recordingDriver } from '../unit/engine/run-value-examples.ts';
import { ORIGIN, unsafePlan } from '../unit/engine/unsafe-feature-steps.ts';
import { printed, withSeededHost } from '../unit/runner/workload-examples.ts';
import { pinnedRunImage } from './isolated-run.ts';
import { realWorkloadRunner } from './workload-run.ts';

export const COMMAND_IMAGE_TAG = `${PRODUCT.name}-database-command`;
const BUILD_TIMEOUT_MILLISECONDS = 600_000;
// The fixture program inside the image: every declared command runs it, and so do the services.
const FIXTURE_PROGRAM = '/opt/database-fixture/database-fixture.mjs';

export const DATABASE_SERVICE_NAME = 'shop-database';
export const OTHER_SERVICE_NAME = 'analytics-database';
export const DATABASE_BANNER = 'database-fixture';
export const DATABASE_SECRET = 'SHOP_DATABASE_PASSWORD';
export const DATABASE_NAME = 'shop';
export const DECLARED_VARIABLES = ['PGDATABASE', 'PGPASSWORD'] as const;
// What the fixture program's note mode prints.
export const TWO_LINE_NOTE = 'first line; rm -rf /\nsecond line $(id)';

const IPV4_ADDRESS = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// The fixture image's id, built from the run image (which is built or reused first).
export async function fixtureCommandImage(): Promise<string> {
  await pinnedRunImage();
  const built = await runDocker([
    'build', '--tag', COMMAND_IMAGE_TAG, '--build-arg', `RUN_IMAGE=${RUN_IMAGE_TAG}`, join(FIXTURES, 'database-command-workload'),
  ], BUILD_TIMEOUT_MILLISECONDS);
  assert.equal(built.status, 0, `the fixture database-command image did not build: ${built.stderr.slice(-2000)}`);
  const id = await dockerCliEngine().imageId(COMMAND_IMAGE_TAG);
  assert.ok(id !== null, 'the fixture database-command image has no id');
  return id;
}

// ---- Services on Docker's default bridge ------------------------------------------------------------

// A fixture service: its address on Docker's default bridge, and how many connections it has seen.
export type Listener = { readonly address: string; connections(): Promise<number>; close(): Promise<void> };
export type Listeners = { readonly database: Listener; readonly otherService: Listener };

// Every fixture service listens on this port inside its own container.
export const SERVICE_PORT = 5432;

// The default bridge's gateway: the Docker host as the bridge sees it, an address a command must
// never reach.
export async function bridgeGateway(): Promise<string> {
  const inspected = await runDocker(['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}']);
  assert.equal(inspected.status, 0, inspected.stderr);
  const gateway = inspected.stdout.trim();
  assert.match(gateway, IPV4_ADDRESS, 'the default bridge has an IPv4 gateway');
  return gateway;
}

// A TCP service: the fixture program's serve mode in a hardened container of the fixture image,
// on the default bridge, publishing nothing. It sends `banner` and a line break to each
// connection, and the test counts connections from its log. The container is removed when it stops.
export async function startFixtureService(image: string, banner: string): Promise<Listener> {
  const name = `${COMMAND_IMAGE_TAG}-service-${randomBytes(6).toString('hex')}`;
  const started = await runDocker([
    'run', '--detach', '--rm', '--name', name, '--network', 'bridge', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', '1000:1000', image, 'node', FIXTURE_PROGRAM, 'serve', banner,
  ]);
  assert.equal(started.status, 0, `the fixture service did not start: ${started.stderr}`);
  const stop = async (): Promise<void> => { await runDocker(['stop', '--time', '1', name]); };
  const logs = async (): Promise<string> => (await runDocker(['logs', name])).stdout;
  for (let tries = 0; tries < 50 && !(await logs()).includes('listening'); tries++) await new Promise((resolve) => setTimeout(resolve, 200));
  const inspected = await runDocker(['inspect', '--format', '{{.NetworkSettings.Networks.bridge.IPAddress}}', name]);
  const address = inspected.stdout.trim();
  if (!IPV4_ADDRESS.test(address)) await stop();
  assert.match(address, IPV4_ADDRESS, `the fixture service has no bridge address: ${inspected.stdout} ${inspected.stderr}`);
  return {
    address,
    connections: async () => (await logs()).split('\n').filter((line) => line.trim() === 'connection').length,
    close: stop,
  };
}

// ---- The project ----------------------------------------------------------------------------------------

const PROGRAM = [{ literal: 'node' }, { literal: FIXTURE_PROGRAM }];
const text = { kind: 'text', maximumLength: 200 };

const commandsFor = (image: string): JsonRecord => {
  const command = (fields: JsonRecord): JsonRecord => ({
    service: DATABASE_SERVICE_NAME, image, successExitCodes: [0], effect: 'read', output: 'json', allowInProposals: false,
    environment: { PGDATABASE: { literal: DATABASE_NAME }, PGPASSWORD: { secretName: DATABASE_SECRET } }, ...fields,
  });
  return {
    echoArguments: command({
      argv: [...PROGRAM, { literal: 'echo' }, { $parameter: 'first' }, { $parameter: 'second' }, { literal: '--' }, { $parameter: 'late' }],
      parameters: { first: text, second: text, late: text },
    }),
    reachAttempts: command({
      argv: [...PROGRAM, { literal: 'reach' }, { $parameter: 'databaseAddress' }, { $parameter: 'otherAddress' }, { $parameter: 'hostAddress' }],
      parameters: { databaseAddress: text, otherAddress: text, hostAddress: text }, timeoutMilliseconds: 120_000,
    }),
    readNote: command({ argv: [...PROGRAM, { literal: 'note' }], parameters: {}, fields: { note: '/note' } }),
    printEnvironment: command({ argv: [...PROGRAM, { literal: 'environment' }], parameters: {} }),
  };
};

// The shared test project, with the declared database and another declared service, each private
// and declared by its address on the default bridge, and only database commands enabled.
export function commandProjectFile(image: string, listeners: Listeners): JsonRecord {
  return testProjectInput({}, {
    services: [
      TEST_SERVICE,
      { name: DATABASE_SERVICE_NAME, origin: `http://${listeners.database.address}`, private: true, port: SERVICE_PORT },
      { name: OTHER_SERVICE_NAME, origin: `http://${listeners.otherService.address}`, private: true, port: SERVICE_PORT },
    ],
    secretNames: [...TEST_SERVICE_SECRET_NAMES, DATABASE_SECRET],
    unsafeFeatures: { databaseCommands: { commands: commandsFor(image) } },
  });
}

// ---- The real port ----------------------------------------------------------------------------------------

export type CommandReply = Result<WorkloadOutcome, WorkloadErrorCode>;
export type CommandPort = { run(request: unknown): Promise<CommandReply> };
type CommandRunnerFactory = (options: { readonly workload: WorkloadRunner; readonly services: readonly DeclaredService[] }) => CommandPort;

function databaseCommandRunner(workload: WorkloadRunner, services: readonly DeclaredService[]): CommandPort {
  const exported: unknown = Object.getOwnPropertyDescriptor(cliPackage, 'databaseCommandRunner')?.value;
  assert.equal(typeof exported, 'function', 'cli exports databaseCommandRunner');
  return (exported as CommandRunnerFactory)({ workload, services });
}

// What the real port was handed and answered, for each command.
export type HandedCommand = { readonly request: unknown; readonly reply: CommandReply };

export type RealCommandRun = { readonly result: RunResult; readonly handed: readonly HandedCommand[]; readonly runnerLog: string };

// Parses `steps` into a 1.3 plan, clears it and runs it with cli's real port over runner's real
// workload runner, with the database secret's value and the host seeded with fake credentials.
export async function runCommandSteps(projectFile: JsonRecord, steps: readonly JsonRecord[], secretValue: string): Promise<RealCommandRun> {
  const parsed = parseProject(projectFile);
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  const project: Project = parsed.value;
  const plan = accepted(planParser(project), unsafePlan(steps));
  const trusted = await trustedProjectFrom(projectFile);
  const { driver } = recordingDriver();
  const { runner, logged } = realWorkloadRunner();
  const real = databaseCommandRunner(runner, project.services);
  const handed: HandedCommand[] = [];
  const spy: CommandPort = {
    async run(request) {
      const reply = await real.run(request);
      handed.push({ request, reply });
      return reply;
    },
  };
  const result = await withSeededHost(() => run({
    plan: authorise(plan, trusted), project, targetId: project.matrix[0]?.id ?? assert.fail('no target'),
    baseUrl: ORIGIN, seed: DEFAULT_SEED, fixedTimeMilliseconds: DEFAULT_CLOCK_START, fixtures: [], host: { platform: 'test', arch: 'test' },
  }, {
    drivers: new Map([[driver.info.id, driver]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(),
    audit: memoryEventSink(), events: memoryRunEventSink(), secrets: environmentSecretStore({ [DATABASE_SECRET]: secretValue }),
    ...{ databaseCommands: spy },
  }));
  return { result, handed, runnerLog: JSON.stringify(logged) };
}

export const runCommandStep = (projectFile: JsonRecord, step: JsonRecord, secretValue: string): Promise<RealCommandRun> =>
  runCommandSteps(projectFile, [step], secretValue);

// The one command's outcome, which must have run.
export function onlyOutcome(ran: RealCommandRun): WorkloadOutcome {
  assert.equal(ran.handed.length, 1, `the run did not hand exactly one command to the port: ${JSON.stringify(ran.result.steps)}`);
  const reply = ran.handed[0]?.reply;
  assert.ok(reply?.ok === true, `the command did not run: ${JSON.stringify(reply)} ${ran.runnerLog}`);
  return reply.value;
}

// The JSON value the command printed on its last line of standard output.
export function printedJson(outcome: WorkloadOutcome): unknown {
  const lines = printed(outcome.stdout).trim().split('\n');
  return JSON.parse(lines.at(-1) ?? 'null');
}
