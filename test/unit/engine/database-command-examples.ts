// Shared setup for the engine tests of database commands: a command the trusted project declares
// under unsafeFeatures.databaseCommands, run in a workload container through the run's
// DatabaseCommandRunner port.
//
//   - commandProjectFile() is the shared test project (plan-examples.ts) with the shop's test
//     database, its password secret and the commands below, and only the database-command feature on;
//   - fakeCommandRunner() stands in for cli's wiring of runner's WorkloadRunner. It records every
//     request it is handed and answers from a route the test gives; by default it echoes the
//     argument vector it received, so a test can see exactly what would reach the program;
//   - runWithCommands() parses a plan, clears it through the policy gate and runs it with the fake
//     as the run's port, on a driver that needs no browser, under a virtual clock.
//
// What these tests assume about shapes the spec leaves open is gathered here, so a change to the
// interface is a change to one file:
//   - the port has one method, run(request), and answers Result<WorkloadOutcome, WorkloadErrorCode>,
//     the workload runner's own outcome: exit code, timedOut, egress events and the two captured
//     streams (contracts' workload.ts);
//   - the request holds `argv` (whole arguments, as strings), `environment` (the declared variables,
//     as { name, value } entries or a record by name, a secret still an opaque Secret), `policy`
//     (an EgressPolicy with allowTcpServices), `timeoutMilliseconds` and `maximumOutputBytes`;
//   - run() takes the port in RunPorts, as `databaseCommands`, beside `services`;
//   - a run without the port reports its database steps as unsupported-step (M1 behaviour).
// See docs/specs/SPEC-36-unsafe-plan-features.md ("Database commands" under "Milestone").
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { success, type EgressEvent, type WorkloadErrorCode, type WorkloadOutcome } from '@revisum/contracts';
import {
  defaultRedactor, environmentSecretStore, parseProject, planParser, run, runUntrusted,
  type LoggedEvent, type PlanStanding, type Project, type Result, type RunResult,
} from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink } from '../../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../../support/policy-clearance.ts';
import { TEST_SERVICE, TEST_SERVICE_SECRET_NAMES, testProjectInput } from './plan-examples.ts';
import { DEFAULT_CLOCK_START, DEFAULT_SEED, accepted, recordingDriver, type Recording } from './run-value-examples.ts';
import { fakeSecretValue } from './secret-examples.ts';
import { virtualClock, type VirtualClock } from './service-call-examples.ts';
import { COMMAND_IMAGE, DATABASE_SECRET, DATABASE_SERVICE, ORIGIN, OPEN_CART, unsafePlan, type JsonRecord } from './unsafe-feature-steps.ts';

export { OPEN_CART, ORIGIN, type JsonRecord };
export { cleanupRecords, stepLines } from './service-call-examples.ts';

// ---- The declared commands ------------------------------------------------------------------------

export const DATABASE_SERVICE_NAME = 'shop-database';
// The fixture program every command runs; its first argument after the file says what it does.
export const PROGRAM = ['node', 'scripts/database-fixture.js'] as const;
// A literal value of the declared environment, and the secret's fresh fake value for this process.
export const DATABASE_NAME = 'shop';
export const DATABASE_PASSWORD = fakeSecretValue();
export const DECLARED_VARIABLES = ['PGDATABASE', 'PGPASSWORD'] as const;
// How long the seed command may run, and the most output the count command may print.
export const SEED_TIMEOUT_MILLISECONDS = 30_000;
export const COUNT_OUTPUT_LIMIT = 64;
// Exit codes the count command declares as success: 3 is its "nothing to count" answer.
export const COUNT_SUCCESS_EXIT_CODES = [0, 3] as const;

const text = { kind: 'text', maximumLength: 200 };
const literal = (value: string): JsonRecord => ({ literal: value });
const parameter = (name: string): JsonRecord => ({ $parameter: name });
const programThen = (...rest: readonly JsonRecord[]): JsonRecord[] => [...PROGRAM.map(literal), ...rest];

const command = (fields: JsonRecord): JsonRecord => ({
  service: DATABASE_SERVICE_NAME, image: COMMAND_IMAGE, successExitCodes: [0],
  environment: { PGDATABASE: { literal: DATABASE_NAME }, PGPASSWORD: { secretName: DATABASE_SECRET } }, ...fields,
});

export const COMMANDS: JsonRecord = {
  // Prints the arguments it was given. Three text parameters, each one whole argument.
  echoArguments: command({
    argv: programThen(literal('echo'), parameter('first'), parameter('second'), parameter('third')),
    parameters: { first: text, second: text, third: text }, effect: 'read', output: 'json', allowInProposals: false,
  }),
  // The same, with one parameter before a literal "--" and one after it.
  echoAroundDashes: command({
    argv: programThen(literal('echo'), parameter('early'), literal('--'), parameter('late')),
    parameters: { early: text, late: text }, effect: 'read', output: 'json', allowInProposals: false,
  }),
  // Prints a note of two lines for a later step to remember.
  readNote: command({
    argv: programThen(literal('note')), parameters: {}, effect: 'read', output: 'json', fields: { note: '/note' }, allowInProposals: false,
  }),
  // Prints a flag-shaped value for a later step to remember.
  readFlag: command({
    argv: programThen(literal('flag')), parameters: {}, effect: 'read', output: 'json', fields: { flag: '/flag' }, allowInProposals: false,
  }),
  // Counts orders. Exit code 3 also means success; its output may be at most 64 bytes.
  countOrders: command({
    argv: programThen(literal('count')), parameters: {}, effect: 'read', output: 'json', fields: { count: '/count' },
    successExitCodes: [...COUNT_SUCCESS_EXIT_CODES], maximumOutputBytes: COUNT_OUTPUT_LIMIT, allowInProposals: false,
  }),
  // Seeds orders: a write, so never run twice.
  seedOrders: command({
    argv: programThen(literal('seed'), parameter('count')), parameters: { count: { kind: 'integer', minimum: 1, maximum: 50 } },
    effect: 'write', output: 'none', timeoutMilliseconds: SEED_TIMEOUT_MILLISECONDS, allowInProposals: true,
  }),
  // Removes the test orders, for cleanup.
  wipeOrders: command({ argv: programThen(literal('wipe')), parameters: {}, effect: 'write', output: 'none', allowInProposals: true }),
};

// The shared test project with the shop's test service and database, the database's password
// secret, and only database commands enabled. `fields` adds or replaces top-level fields.
export const commandProjectFile = (fields: JsonRecord = {}, limits: Readonly<Record<string, number>> = {}): JsonRecord =>
  testProjectInput(limits, {
    services: [TEST_SERVICE, DATABASE_SERVICE],
    secretNames: [...TEST_SERVICE_SECRET_NAMES, DATABASE_SECRET],
    unsafeFeatures: { databaseCommands: { commands: COMMANDS } },
    ...fields,
  });

export function commandProject(projectFile: JsonRecord = commandProjectFile()): Project {
  const parsed = parseProject(projectFile);
  if (!parsed.ok) throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// ---- Plan parts -----------------------------------------------------------------------------------

export const database = (name: string, commandArguments: JsonRecord = {}, remember?: JsonRecord): JsonRecord =>
  ({ type: 'database', command: name, arguments: commandArguments, ...(remember === undefined ? {} : { remember }) });

export const expectDatabase = (name: string, field: string, assertion: JsonRecord, commandArguments: JsonRecord = {}): JsonRecord =>
  ({ type: 'expectDatabase', command: name, arguments: commandArguments, field, assert: assertion, criterionId: 'orders.database-state' });

export const echo = (first: unknown, second: unknown = 'plain', third: unknown = 'text'): JsonRecord =>
  database('echoArguments', { first, second, third });

export const SEED_ORDERS = database('seedOrders', { count: 3 });
export const WIPE_ORDERS = database('wipeOrders');
export const COUNT_ORDERS = database('countOrders');

// A 1.3 plan: the given steps, then a check the recording driver always passes.
export const commandPlan = (steps: readonly unknown[], cleanup?: readonly unknown[]): JsonRecord =>
  unsafePlan(steps, cleanup === undefined ? {} : { cleanup });

// ---- The fake port ------------------------------------------------------------------------------

// What a test reads of one request the fake was handed. `request` is the whole request, as handed.
export type SeenCommand = {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, unknown>>;
  readonly request: Readonly<Record<string, unknown>>;
};

// One answer: any field left out takes its ordinary value (exit 0, in time, nothing cut, no events).
export type CommandAnswer = {
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly stdout?: string;
  readonly truncated?: boolean;
  readonly egressEvents?: readonly EgressEvent[];
};
export type CommandReply = Result<WorkloadOutcome, WorkloadErrorCode>;
// Answers one command; `earlier` is every command the fake was handed before it. Undefined falls
// through to the default route.
export type CommandRoute = (seen: SeenCommand, earlier: readonly SeenCommand[]) => CommandAnswer | undefined;

const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined;

// The request's environment by variable name, from { name, value } entries or a record.
function environmentOf(request: unknown): Readonly<Record<string, unknown>> {
  const environment = fieldOf(request, 'environment');
  if (Array.isArray(environment)) {
    return Object.fromEntries(environment.map((entry: unknown) => [String(fieldOf(entry, 'name')), fieldOf(entry, 'value')]));
  }
  assert.ok(typeof environment === 'object' && environment !== null, `the request has no environment: ${JSON.stringify(request)}`);
  return Object.fromEntries(Object.entries(environment));
}

function seenOf(request: unknown): SeenCommand {
  assert.ok(typeof request === 'object' && request !== null, 'the request is an object');
  const argv = fieldOf(request, 'argv');
  assert.ok(Array.isArray(argv) && argv.every((argument) => typeof argument === 'string'), `the request's argv is not a list of strings: ${JSON.stringify(request)}`);
  return { argv: [...argv], environment: environmentOf(request), request: Object.fromEntries(Object.entries(request)) };
}

// The program's mode: the first argument after the program and its file.
export const modeOf = (seen: SeenCommand): string => seen.argv[PROGRAM.length] ?? '';

export const ECHO_OUTPUT = (seen: SeenCommand): string => JSON.stringify({ arguments: seen.argv.slice(PROGRAM.length + 1) });
export const FLAG_VALUE = '--force';
// What the note command prints: text holding a line break, as a page element or a service field may.
export const TWO_LINE_NOTE = 'first line; rm -rf /\nsecond line $(id)';

// The fixture program as the default route: echo prints its arguments, flag prints a flag-shaped
// value, count prints three orders, seed and wipe print nothing.
export const DEFAULT_ROUTE: CommandRoute = (seen) => {
  const mode = modeOf(seen);
  if (mode === 'echo') return { stdout: ECHO_OUTPUT(seen) };
  if (mode === 'flag') return { stdout: JSON.stringify({ flag: FLAG_VALUE }) };
  if (mode === 'note') return { stdout: JSON.stringify({ note: TWO_LINE_NOTE }) };
  if (mode === 'count') return { stdout: JSON.stringify({ count: 3 }) };
  return { stdout: '' };
};

// The default route, with `override` answering first for the commands it chooses.
export const routeWith = (override: CommandRoute): CommandRoute =>
  (seen, earlier) => override(seen, earlier) ?? DEFAULT_ROUTE(seen, earlier);

// The default route, with every command in `mode` answering `answer`.
export const modeAnswers = (mode: string, answer: CommandAnswer): CommandRoute =>
  routeWith((seen) => (modeOf(seen) === mode ? answer : undefined));

const outputOf = (text: string, truncated = false) => ({ bytes: new TextEncoder().encode(text), truncated });

export function outcomeOf(answer: CommandAnswer): CommandReply {
  return success({
    exitCode: answer.exitCode ?? 0, timedOut: answer.timedOut ?? false, egressEvents: [...(answer.egressEvents ?? [])],
    stdout: outputOf(answer.stdout ?? '', answer.truncated ?? false), stderr: outputOf(''),
  });
}

export type FakeCommandRunner = {
  readonly port: { run(request: unknown): Promise<CommandReply> };
  readonly commands: SeenCommand[];
};

export function fakeCommandRunner(route: CommandRoute = DEFAULT_ROUTE): FakeCommandRunner {
  const commands: SeenCommand[] = [];
  const port = {
    async run(request: unknown): Promise<CommandReply> {
      const seen = seenOf(request);
      const earlier = [...commands];
      commands.push(seen);
      return outcomeOf(route(seen, earlier) ?? DEFAULT_ROUTE(seen, earlier) ?? {});
    },
  };
  return { port, commands };
}

// The commands the fake saw, by mode.
export const modesOf = (commands: readonly SeenCommand[]): string[] => commands.map(modeOf);

// ---- Running a plan with commands -------------------------------------------------------------------

export type CommandRunOptions = {
  readonly route?: CommandRoute;
  readonly projectFile?: JsonRecord;
  readonly standing?: PlanStanding;
  // False runs with no port at all, as a run whose port is not wired in.
  readonly withPort?: boolean;
};

export type CommandRun = {
  readonly result: RunResult;
  readonly recording: Recording;
  readonly commands: readonly SeenCommand[];
  readonly events: readonly LoggedEvent[];
  readonly clock: VirtualClock;
  // The result and the run's event log, as JSON.
  readonly everything: string;
};

// The port as RunPorts carries it; see the assumptions at the top.
const portFields = (port: FakeCommandRunner['port'] | undefined): Readonly<Record<string, unknown>> =>
  (port === undefined ? {} : { databaseCommands: port });

export async function runWithCommands(raw: unknown, options: CommandRunOptions = {}): Promise<CommandRun> {
  const projectFile = options.projectFile ?? commandProjectFile();
  const project = commandProject(projectFile);
  const plan = accepted(planParser(project), raw);
  const trusted = await trustedProjectFrom(projectFile);
  const { driver, recording } = recordingDriver();
  const { port, commands } = fakeCommandRunner(options.route);
  const wired = portFields(options.withPort === false ? undefined : port);
  const clock = virtualClock();
  const events = memoryRunEventSink();
  const result = await run({
    plan: authorise(plan, trusted, options.standing), project, targetId: project.matrix[0]?.id ?? assert.fail('no target'),
    baseUrl: ORIGIN, seed: DEFAULT_SEED, fixedTimeMilliseconds: DEFAULT_CLOCK_START, fixtures: [], host: { platform: 'test', arch: 'test' },
    ...(options.standing === undefined ? {} : { standing: options.standing }),
  }, {
    drivers: new Map([[driver.info.id, driver]]), clock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), audit: memoryEventSink(), events,
    secrets: environmentSecretStore({ [DATABASE_SECRET]: DATABASE_PASSWORD }),
    ...wired,
  });
  const logged = events.read();
  return { result, recording, commands, events: logged, clock, everything: `${JSON.stringify(result)}\n${JSON.stringify(logged)}` };
}

// runUntrusted with the fake port: the plan is parsed, then judged by the gate, then run.
export async function runUntrustedWithCommands(raw: unknown, projectFile: JsonRecord): Promise<{
  readonly outcome: Awaited<ReturnType<typeof runUntrusted>>;
  readonly commands: readonly SeenCommand[];
  readonly opens: number;
}> {
  const project = commandProject(projectFile);
  const { driver, recording } = recordingDriver();
  const { port, commands } = fakeCommandRunner();
  const wired = portFields(port);
  const outcome = await runUntrusted(raw, planParser(project), {
    project, baseUrl: ORIGIN, seed: DEFAULT_SEED, fixedTimeMilliseconds: DEFAULT_CLOCK_START, fixtures: [], host: { platform: 'test', arch: 'test' },
  }, {
    drivers: new Map([[driver.info.id, driver]]), clock: virtualClock(), artifacts: memoryArtifactStore(), redactor: defaultRedactor(),
    audit: memoryEventSink(), events: memoryRunEventSink(), secrets: environmentSecretStore({ [DATABASE_SECRET]: DATABASE_PASSWORD }),
    ...wired,
  });
  return { outcome, commands, opens: recording.environments.length };
}

// ---- Records ------------------------------------------------------------------------------------------

export const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// The record a step result keeps of its command: the one field of the step that is an object naming it.
export function commandRecordOf(result: RunResult, index: number, name: string): Readonly<Record<string, unknown>> {
  const step = result.steps.find((candidate) => candidate.index === index);
  assert.ok(step !== undefined, `the result has no step ${index}`);
  const record = Object.values(step).find((value: unknown) => fieldOf(value, 'command') === name);
  assert.ok(typeof record === 'object' && record !== null, `step ${index} records no command named ${name}: ${JSON.stringify(step)}`);
  return Object.fromEntries(Object.entries(record));
}
