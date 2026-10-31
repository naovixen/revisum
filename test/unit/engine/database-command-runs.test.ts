// Database commands in a run, against a fake DatabaseCommandRunner port in place of cli's wiring of
// runner's workload runner. The engine builds each request and decodes the outcome itself:
//   - an exit code outside successExitCodes fails the step with command-failed, a timeout with
//     command-timeout, and output over maximumOutputBytes, cut short, or not JSON (for a command
//     whose output is json) with command-output-invalid. Any of them ends the run Errored, skips
//     the later steps, and cleanup still runs;
//   - a write command is never run twice, even when it times out; an expectDatabase check reruns
//     its read command until it passes or backendCheckTimeoutMilliseconds runs out, then the run
//     ends Failed;
//   - the request's environment holds only the declared variables, a secret still opaque, and its
//     egress policy reaches only the command's own service;
//   - a command whose service is on a production origin is denied before it starts;
//   - each command's record holds its name, service, exit code and output sha256, never the raw
//     output or an environment value.
// See docs/specs/SPEC-36-unsafe-plan-features.md ("Database commands" under "Milestone").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEST_SERVICE } from './plan-examples.ts';
import {
  COUNT_ORDERS, COUNT_OUTPUT_LIMIT, DATABASE_NAME, DATABASE_PASSWORD, DATABASE_SERVICE_NAME, DECLARED_VARIABLES, OPEN_CART, ORIGIN,
  SEED_ORDERS, SEED_TIMEOUT_MILLISECONDS, WIPE_ORDERS, cleanupRecords, commandPlan, commandProjectFile, commandRecordOf, expectDatabase,
  database, modeAnswers, modesOf, routeWith, runUntrustedWithCommands, runWithCommands, sha256Of, stepLines, COMMANDS,
  type CommandAnswer, type JsonRecord,
} from './database-command-examples.ts';
import { DATABASE_SERVICE } from './unsafe-feature-steps.ts';

// A JSON text of exactly `bytes` bytes: {"count":3,"padding":"xxx…"}.
function jsonOfLength(bytes: number): string {
  const empty = JSON.stringify({ count: 3, padding: '' });
  const text = JSON.stringify({ count: 3, padding: 'x'.repeat(bytes - empty.length) });
  assert.equal(new TextEncoder().encode(text).length, bytes);
  return text;
}

// ---- A command that fails ---------------------------------------------------------------------------

const FAILED_COMMANDS: readonly { readonly name: string; readonly answer: CommandAnswer; readonly code: string }[] = [
  { name: 'exits with 1, outside successExitCodes', answer: { exitCode: 1, stdout: '{"count":3}' }, code: 'command-failed' },
  { name: 'exits with 2, outside successExitCodes', answer: { exitCode: 2, stdout: '{"count":3}' }, code: 'command-failed' },
  { name: 'times out', answer: { exitCode: 137, timedOut: true, stdout: '' }, code: 'command-timeout' },
  { name: 'times out after printing valid JSON', answer: { exitCode: 0, timedOut: true, stdout: '{"count":3}' }, code: 'command-timeout' },
  { name: 'prints one byte more than maximumOutputBytes', answer: { stdout: jsonOfLength(COUNT_OUTPUT_LIMIT + 1) }, code: 'command-output-invalid' },
  { name: 'prints output the runner cut short', answer: { stdout: '{"count":3,', truncated: true }, code: 'command-output-invalid' },
  { name: 'prints text that is not JSON', answer: { stdout: 'count: 3' }, code: 'command-output-invalid' },
  { name: 'prints nothing, though its output is json', answer: { stdout: '' }, code: 'command-output-invalid' },
  { name: 'prints two JSON values', answer: { stdout: '{"count":3}\n{"count":4}' }, code: 'command-output-invalid' },
];

for (const failed of FAILED_COMMANDS) {
  test(`a command that ${failed.name} fails with ${failed.code}, ends the run Errored and skips later steps`, { criterion: 'AC-SPEC-36-14' }, async () => {
    const ran = await runWithCommands(commandPlan([OPEN_CART, COUNT_ORDERS, OPEN_CART], [WIPE_ORDERS]), { route: modeAnswers('count', failed.answer) });
    assert.equal(ran.result.state, 'Errored');
    assert.deepEqual(stepLines(ran.result), ['navigate passed', `database failed ${failed.code}`, 'navigate skipped', 'expect skipped']);
    assert.equal(ran.recording.navigations.length, 1, 'a step after the failed command reached the page');
  });

  test(`after a command that ${failed.name}, cleanup still runs`, { criterion: 'AC-SPEC-36-14' }, async () => {
    const ran = await runWithCommands(commandPlan([COUNT_ORDERS], [WIPE_ORDERS]), { route: modeAnswers('count', failed.answer) });
    assert.deepEqual(modesOf(ran.commands), ['count', 'wipe']);
    assert.deepEqual(cleanupRecords(ran.result).map((record) => record.outcome), ['passed']);
  });
}

// Counter-examples: the edges of each rule pass.
const PASSING_COMMANDS: readonly { readonly name: string; readonly answer: CommandAnswer }[] = [
  { name: 'exits with 0', answer: { exitCode: 0, stdout: '{"count":3}' } },
  { name: 'exits with 3, which successExitCodes also lists', answer: { exitCode: 3, stdout: '{"count":0}' } },
  { name: 'prints exactly maximumOutputBytes of JSON', answer: { stdout: jsonOfLength(COUNT_OUTPUT_LIMIT) } },
  { name: 'prints JSON with a trailing line break', answer: { stdout: '{"count":3}\n' } },
];

for (const passing of PASSING_COMMANDS) {
  test(`counter-example: a command that ${passing.name} passes, and the steps after it run`, { criterion: 'AC-SPEC-36-14' }, async () => {
    const ran = await runWithCommands(commandPlan([OPEN_CART, COUNT_ORDERS, OPEN_CART]), { route: modeAnswers('count', passing.answer) });
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    assert.deepEqual(stepLines(ran.result), ['navigate passed', 'database passed', 'navigate passed', 'expect passed']);
  });
}

test('a command whose output is none passes whatever it prints', { criterion: 'AC-SPEC-36-14' }, async () => {
  const ran = await runWithCommands(commandPlan([SEED_ORDERS]), { route: modeAnswers('seed', { stdout: 'seeded 3 orders, not JSON' }) });
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
});

test('a write command that exits outside successExitCodes ends the run Errored, and cleanup still runs', { criterion: 'AC-SPEC-36-14' }, async () => {
  const ran = await runWithCommands(commandPlan([OPEN_CART, SEED_ORDERS, OPEN_CART], [WIPE_ORDERS]), {
    route: modeAnswers('seed', { exitCode: 1, stdout: '' }),
  });
  assert.equal(ran.result.state, 'Errored');
  assert.deepEqual(stepLines(ran.result).slice(0, 3), ['navigate passed', 'database failed command-failed', 'navigate skipped']);
  assert.deepEqual(modesOf(ran.commands), ['seed', 'wipe']);
});

// ---- A write is never run twice ------------------------------------------------------------------------

test('a write command that times out has run exactly once', { criterion: 'AC-SPEC-36-14' }, async () => {
  const ran = await runWithCommands(commandPlan([OPEN_CART, SEED_ORDERS, OPEN_CART], [WIPE_ORDERS]), {
    route: modeAnswers('seed', { exitCode: 137, timedOut: true }),
  });
  assert.deepEqual(stepLines(ran.result).slice(0, 2), ['navigate passed', 'database failed command-timeout']);
  assert.equal(modesOf(ran.commands).filter((mode) => mode === 'seed').length, 1, 'the write command ran again');
  assert.deepEqual(modesOf(ran.commands), ['seed', 'wipe'], 'cleanup did not run after the timeout');
});

test('a write command that fails is not retried either', { criterion: 'AC-SPEC-36-14' }, async () => {
  const ran = await runWithCommands(commandPlan([SEED_ORDERS]), { route: modeAnswers('seed', { exitCode: 1 }) });
  assert.equal(modesOf(ran.commands).filter((mode) => mode === 'seed').length, 1);
});

test('the write command is handed its declared timeout', { criterion: 'AC-SPEC-36-14' }, async () => {
  const ran = await runWithCommands(commandPlan([SEED_ORDERS]));
  assert.equal(ran.commands[0]?.request['timeoutMilliseconds'], SEED_TIMEOUT_MILLISECONDS);
});

// Counter-example: the counter can see a command run more than once. A read check reruns its
// command until it passes, and ends the run Failed when it never does.
const COUNT_IS_THREE = expectDatabase('countOrders', 'count', { kind: 'numberEquals', value: 3 });

test('counter-example: an expectDatabase check reruns its read command until it passes', { criterion: 'AC-SPEC-36-14' }, async () => {
  const route = routeWith((seen, earlier) => (seen.argv.includes('count') ? { stdout: JSON.stringify({ count: earlier.length < 2 ? 1 : 3 }) } : undefined));
  const ran = await runWithCommands(commandPlan([COUNT_IS_THREE]), { route });
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.equal(modesOf(ran.commands).filter((mode) => mode === 'count').length, 3);
});

test('an expectDatabase check that never passes ends the run Failed after backendCheckTimeoutMilliseconds, and cleanup still runs', { criterion: 'AC-SPEC-36-14' }, async () => {
  const timeout = 2000;
  const ran = await runWithCommands(commandPlan([COUNT_IS_THREE, OPEN_CART], [WIPE_ORDERS]), {
    route: modeAnswers('count', { stdout: JSON.stringify({ count: 1 }) }),
    projectFile: commandProjectFile({}, { backendCheckTimeoutMilliseconds: timeout }),
  });
  assert.equal(ran.result.state, 'Failed');
  assert.deepEqual(stepLines(ran.result).slice(0, 2), ['expectDatabase failed assertion-failed', 'navigate skipped']);
  assert.ok(modesOf(ran.commands).filter((mode) => mode === 'count').length > 1, 'the read command was not rerun');
  assert.ok(ran.clock.elapsed() >= timeout, `the check gave up after ${ran.clock.elapsed()} ms`);
  assert.equal(modesOf(ran.commands).at(-1), 'wipe');
});

// ---- Cleanup -------------------------------------------------------------------------------------------

test('a cleanup command that fails is recorded cleanup-failed, and the passing verdict does not change', { criterion: 'AC-SPEC-36-14' }, async () => {
  const ran = await runWithCommands(commandPlan([SEED_ORDERS], [WIPE_ORDERS]), { route: modeAnswers('wipe', { exitCode: 1 }) });
  assert.equal(ran.result.state, 'Passed');
  assert.deepEqual(cleanupRecords(ran.result).map((record) => `${record.outcome} ${record.code ?? ''}`), ['failed cleanup-failed']);
});

test('cleanup commands run in order after a passing run', { criterion: 'AC-SPEC-36-14' }, async () => {
  const ran = await runWithCommands(commandPlan([SEED_ORDERS], [WIPE_ORDERS, database('seedOrders', { count: 1 })]));
  assert.equal(ran.result.state, 'Passed');
  assert.deepEqual(modesOf(ran.commands), ['seed', 'wipe', 'seed']);
  assert.deepEqual(cleanupRecords(ran.result).map((record) => record.outcome), ['passed', 'passed']);
});

// ---- Records ---------------------------------------------------------------------------------------------

const RAW_OUTPUT_MARKER = 'raw-output-marker-q7zx';

test('a command\'s record holds its name, service, exit code and output sha256, never the raw output', { criterion: 'AC-SPEC-36-14' }, async () => {
  const output = JSON.stringify({ count: 3, note: RAW_OUTPUT_MARKER });
  const projectFile = commandProjectFile({
    unsafeFeatures: { databaseCommands: { commands: { ...COMMANDS, countOrders: { ...(COMMANDS['countOrders'] as JsonRecord), maximumOutputBytes: 4096 } } } },
  });
  const ran = await runWithCommands(commandPlan([COUNT_ORDERS]), { route: modeAnswers('count', { exitCode: 3, stdout: output }), projectFile });
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  const record = commandRecordOf(ran.result, 0, 'countOrders');
  assert.equal(record['service'], DATABASE_SERVICE_NAME);
  assert.equal(record['exitCode'], 3);
  assert.ok(Object.values(record).includes(sha256Of(output)), `the record keeps no sha256 of the output: ${JSON.stringify(record)}`);
  assert.ok(!ran.everything.includes(RAW_OUTPUT_MARKER), 'the raw output reached the result or the log');
});

// ---- The request's environment and network (the engine's half; the container half is in
// test/containers/database-commands.test.ts) ---------------------------------------------------------------

test('the request\'s environment holds exactly the declared variables', { criterion: 'AC-SPEC-36-13' }, async () => {
  const seeded = 'GITHUB_TOKEN';
  const before = process.env[seeded];
  process.env[seeded] = 'ghp_fakeTokenSeededForDatabaseCommandTests';
  try {
    const ran = await runWithCommands(commandPlan([SEED_ORDERS]));
    assert.deepEqual(Object.keys(ran.commands[0]?.environment ?? {}).sort(), [...DECLARED_VARIABLES].sort());
    assert.equal(ran.commands[0]?.environment['PGDATABASE'], DATABASE_NAME);
  } finally {
    if (before === undefined) Reflect.deleteProperty(process.env, seeded);
    else process.env[seeded] = before;
  }
});

test('the declared secret reaches the port as an opaque Secret, never as its value', { criterion: 'AC-SPEC-36-13' }, async () => {
  const ran = await runWithCommands(commandPlan([SEED_ORDERS]));
  assert.equal(ran.commands.length, 1, 'the command was not handed to the port');
  const password = ran.commands[0]?.environment['PGPASSWORD'];
  assert.notEqual(typeof password, 'string', 'the secret was revealed before the port');
  assert.ok(!JSON.stringify(ran.commands[0]?.request).includes(DATABASE_PASSWORD), 'the request holds the secret\'s value');
  assert.ok(!ran.everything.includes(DATABASE_PASSWORD), 'the secret\'s value reached the result or the log');
});

test('the request\'s egress policy reaches only the command\'s own service, over TCP, and no origin', { criterion: 'AC-SPEC-36-13' }, async () => {
  const ran = await runWithCommands(commandPlan([SEED_ORDERS]));
  const policy = ran.commands[0]?.request['policy'];
  assert.ok(typeof policy === 'object' && policy !== null, JSON.stringify(ran.commands[0]?.request));
  assert.deepEqual(Reflect.get(policy, 'allowTcpServices'), [DATABASE_SERVICE_NAME]);
  assert.deepEqual(Reflect.get(policy, 'allowOrigins'), [], 'the command may reach a web origin');
  assert.deepEqual(Reflect.get(policy, 'allowServices'), [], `the command may reach ${String(TEST_SERVICE['name'])} over HTTP`);
});

// ---- Production ------------------------------------------------------------------------------------------

const PRODUCTION_ORIGIN = 'https://shop.example.com';
const LIVE_DATABASE: JsonRecord = { name: 'live-database', origin: PRODUCTION_ORIGIN, private: true, port: 5432 };
const PRODUCTION_PROJECT = commandProjectFile({
  origins: [ORIGIN, PRODUCTION_ORIGIN],
  productionOrigins: [PRODUCTION_ORIGIN],
  services: [TEST_SERVICE, DATABASE_SERVICE, LIVE_DATABASE],
  unsafeFeatures: {
    databaseCommands: { commands: { ...COMMANDS, seedLiveOrders: { ...(COMMANDS['seedOrders'] as JsonRecord), service: 'live-database' } } },
  },
});

test('a command whose service is on a production origin is denied production-origin before it starts: the port is never called', { criterion: 'AC-SPEC-36-13' }, async () => {
  const { outcome, commands, opens } = await runUntrustedWithCommands(commandPlan([OPEN_CART, { type: 'database', command: 'seedLiveOrders', arguments: { count: 3 } }]), PRODUCTION_PROJECT);
  assert.ok('rule' in outcome && outcome.rule === 'production-origin', JSON.stringify(outcome));
  assert.deepEqual(commands, [], 'the command was handed to the port');
  assert.equal(opens, 0, 'a browser was opened');
});

test('counter-example: the same command on the test database, in the same project, reaches the port once', { criterion: 'AC-SPEC-36-13' }, async () => {
  const { outcome, commands } = await runUntrustedWithCommands(commandPlan([OPEN_CART, SEED_ORDERS]), PRODUCTION_PROJECT);
  assert.ok(Array.isArray(outcome), JSON.stringify(outcome));
  assert.deepEqual(modesOf(commands), ['seed']);
});
