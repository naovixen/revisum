// Database commands for real, on Docker: a plan's database step runs the fixture program in the
// fixture image through cli's DatabaseCommandRunner and runner's workload runner.
//   - Arguments holding shell syntax, and a remembered value holding a line break, reach the
//     program as literal single arguments, with no shell, and an argument starting with "-" after
//     a declared literal "--" reaches it too (AC-12).
//   - The command reaches its own service's port by the service's declared name, which the
//     workload maps to the proxy's relay, and nothing else: the internet, the
//     metadata address, another declared service and the Docker host (the CI host) are all
//     blocked. Attempts by a name the proxy sees are recorded as blocked egress events (AC-13).
//   - Its environment holds only the declared variables, the image's own and the container's
//     own HOSTNAME and HOME: no proxy variable and nothing from the host (AC-13).
// The services are containers on Docker's default bridge, declared by address, so the tests run
// the same on Docker Desktop and on Linux CI. A raw address can't be redirected to the relay without
// network-admin rights in the container, so a command connects by the service's name (founder,
// 2026-10-31).
// The engine's half of each rule, against a fake port, is in test/unit/engine/database-command-*.
// See docs/specs/SPEC-36-unsafe-plan-features.md ("Database commands" under "Milestone").
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { EgressEvent } from '@revisum/contracts';
import { fakeSecretValue } from '../unit/engine/secret-examples.ts';
import { hostOf } from '../unit/runner/runner-examples.ts';
import { DISTINCTIVE_HOST_VALUES } from '../unit/runner/workload-examples.ts';
import {
  DATABASE_BANNER, DATABASE_NAME, DATABASE_SERVICE_NAME, DECLARED_VARIABLES, bridgeGateway, commandProjectFile, fixtureCommandImage, onlyOutcome,
  printedJson, runCommandStep, runCommandSteps, startFixtureService, type Listeners,
} from './database-command-run.ts';
import { imageEnvironmentNames } from './workload-run.ts';

const TIMEOUT = 600_000;

let image: string;
let listeners: Listeners;
// The Docker host as the default bridge sees it: the CI host, which no command may reach.
let dockerHost: string;
before(async () => {
  image = await fixtureCommandImage();
  dockerHost = await bridgeGateway();
  listeners = { database: await startFixtureService(image, DATABASE_BANNER), otherService: await startFixtureService(image, 'other-service') };
}, { timeout: TIMEOUT });
after(async () => {
  await Promise.all([listeners?.database.close(), listeners?.otherService.close()]);
}, { timeout: TIMEOUT });

const step = (command: string, commandArguments: Readonly<Record<string, unknown>> = {}) => ({ type: 'database', command, arguments: commandArguments });

// ---- Arguments ----------------------------------------------------------------------------------------

test('"; rm -rf /" and "$(id)" reach the program as literal single arguments, and "-rf" after a declared "--" as one argument', { criterion: 'AC-SPEC-36-12', timeout: TIMEOUT }, async () => {
  const ran = await runCommandStep(commandProjectFile(image, listeners), step('echoArguments', { first: '; rm -rf /', second: '$(id)', late: '-rf' }), fakeSecretValue());
  const outcome = onlyOutcome(ran);
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome));
  assert.deepEqual(printedJson(outcome), { arguments: ['; rm -rf /', '$(id)', '--', '-rf'] });
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
});

test('a line break never reaches the program: remembering it fails with value-unsafe, and the echo command never starts', { criterion: 'AC-SPEC-36-12', timeout: TIMEOUT }, async () => {
  const ran = await runCommandSteps(commandProjectFile(image, listeners), [
    { ...step('readNote'), remember: { noteText: 'note' } },
    step('echoArguments', { first: { valueName: 'noteText' }, second: 'plain', late: 'text' }),
  ], fakeSecretValue());
  assert.equal(ran.result.state, 'Errored');
  assert.equal(ran.result.steps[0]?.code, 'value-unsafe');
  assert.equal(ran.handed.length, 1, `a command after the refused value was handed to the port: ${JSON.stringify(ran.result.steps)}`);
  assert.ok(!JSON.stringify(ran.result).includes('second line'), 'the note reached the result');
});

test('a leading "-" before the declared "--" fails with parameter-invalid, and no container starts', { criterion: 'AC-SPEC-36-12', timeout: TIMEOUT }, async () => {
  const ran = await runCommandStep(commandProjectFile(image, listeners), step('echoArguments', { first: '-rf', second: 'plain', late: 'text' }), fakeSecretValue());
  assert.equal(ran.result.state, 'Errored');
  assert.equal(ran.result.steps[0]?.code, 'parameter-invalid');
  assert.deepEqual(ran.handed, [], 'the command was handed to the port');
});

// ---- Network reach --------------------------------------------------------------------------------------

type Attempts = { readonly seen: Readonly<Record<string, unknown>>; readonly events: readonly EgressEvent[] };
let attempts: Attempts | undefined;

// The reach attempts run once; every reach test reads what they saw and what was recorded.
async function reachAttempts(): Promise<Attempts> {
  if (attempts === undefined) {
    const ran = await runCommandStep(commandProjectFile(image, listeners), step('reachAttempts', {
      databaseAddress: DATABASE_SERVICE_NAME, otherAddress: listeners.otherService.address, hostAddress: dockerHost,
    }), fakeSecretValue());
    const outcome = onlyOutcome(ran);
    assert.equal(outcome.exitCode, 0, `the reach attempts failed to run: ${JSON.stringify(outcome)}`);
    const seen = printedJson(outcome);
    assert.ok(typeof seen === 'object' && seen !== null, JSON.stringify(seen));
    attempts = { seen: Object.fromEntries(Object.entries(seen)), events: outcome.egressEvents };
  }
  return attempts;
}

const eventsFor = (events: readonly EgressEvent[], host: string): readonly EgressEvent[] =>
  events.filter((event) => hostOf(String(event.origin)) === host);

test('counter-example: the command reaches its own service\'s declared port, by the service\'s name', { criterion: 'AC-SPEC-36-13', timeout: TIMEOUT }, async () => {
  const { seen } = await reachAttempts();
  assert.equal(seen['declared-database'], `reached:${DATABASE_BANNER}`);
  assert.ok(await listeners.database.connections() >= 1, 'the declared database saw no connection');
});

const BLOCKED_ATTEMPTS = [
  { attempt: 'another declared service, on the same bridge and port', name: 'other-service' },
  { attempt: 'the CI host, by the bridge gateway\'s address', name: 'ci-host-by-address' },
  { attempt: 'the CI host\'s Docker API, by the bridge gateway\'s address', name: 'ci-host-docker-api' },
  { attempt: 'the CI host, by the name host.docker.internal', name: 'ci-host-by-name' },
  { attempt: 'the internet, by name', name: 'internet-by-name' },
  { attempt: 'the internet, by address', name: 'internet-by-address' },
  { attempt: 'the cloud metadata service, by name', name: 'metadata-by-name' },
  { attempt: 'the cloud metadata address', name: 'metadata-by-address' },
];

for (const { attempt, name } of BLOCKED_ATTEMPTS) {
  test(`a connection to ${attempt} is blocked`, { criterion: 'AC-SPEC-36-13', timeout: TIMEOUT }, async () => {
    const { seen } = await reachAttempts();
    assert.equal(seen[name], 'blocked');
  });
}

test('the other declared service saw no connection', { criterion: 'AC-SPEC-36-13', timeout: TIMEOUT }, async () => {
  await reachAttempts();
  assert.equal(await listeners.otherService.connections(), 0, 'the other declared service was reached');
});

for (const host of ['example.com', 'metadata.google.internal']) {
  test(`the attempt to reach ${host} by name is recorded as a blocked egress event`, { criterion: 'AC-SPEC-36-13', timeout: TIMEOUT }, async () => {
    const { events } = await reachAttempts();
    const recorded = eventsFor(events, host);
    assert.ok(recorded.length >= 1, `nothing was recorded for ${host}: ${JSON.stringify(events)}`);
    assert.ok(recorded.every((event) => event.decision === 'blocked'), JSON.stringify(recorded));
  });
}

test('no egress event allows anything but the declared database', { criterion: 'AC-SPEC-36-13', timeout: TIMEOUT }, async () => {
  const { events } = await reachAttempts();
  const allowed = events.filter((event) => event.decision === 'allowed');
  assert.ok(allowed.every((event) => event.origin.includes(listeners.database.address)), JSON.stringify(allowed));
});

// ---- The environment ------------------------------------------------------------------------------------

// The names a container sets for itself: its host name, and the home folder the runner gives it.
const CONTAINER_OWN = ['HOSTNAME', 'HOME'];
const PROXY_VARIABLE = /proxy/i;

let inside: Readonly<Record<string, string>> | undefined;
const secretValue = fakeSecretValue();

async function environmentInside(): Promise<Readonly<Record<string, string>>> {
  if (inside === undefined) {
    const ran = await runCommandStep(commandProjectFile(image, listeners), step('printEnvironment'), secretValue);
    const printedEnvironment = printedJson(onlyOutcome(ran));
    assert.ok(typeof printedEnvironment === 'object' && printedEnvironment !== null);
    inside = Object.fromEntries(Object.entries(printedEnvironment).map(([name, value]) => [name, String(value)]));
  }
  return inside;
}

test('the command\'s environment holds only the declared variables, the image\'s own and the container\'s own', { criterion: 'AC-SPEC-36-13', timeout: TIMEOUT }, async () => {
  const environment = await environmentInside();
  const allowed = new Set<string>([...DECLARED_VARIABLES, ...CONTAINER_OWN, ...await imageEnvironmentNames(image)]);
  assert.deepEqual(Object.keys(environment).filter((name) => !allowed.has(name)), []);
});

test('the command\'s environment holds no proxy variable, since the command speaks TCP', { criterion: 'AC-SPEC-36-13', timeout: TIMEOUT }, async () => {
  const environment = await environmentInside();
  assert.deepEqual(Object.keys(environment).filter((name) => PROXY_VARIABLE.test(name)), []);
});

test('no host credential\'s name or value is in the command\'s environment', { criterion: 'AC-SPEC-36-13', timeout: TIMEOUT }, async () => {
  const environment = await environmentInside();
  assert.deepEqual(Object.keys(environment).filter((name) => name.startsWith('GITHUB_') || /^(AWS_|AZURE_|GOOGLE_|GCP_|NPM_|ACTIONS_)/.test(name)), []);
  const values = Object.values(environment);
  for (const value of DISTINCTIVE_HOST_VALUES) assert.ok(!values.some((text) => text.includes(value)), 'a host credential\'s value is inside');
});

test('counter-example: the declared literal and the declared secret\'s value are in the command\'s environment', { criterion: 'AC-SPEC-36-13', timeout: TIMEOUT }, async () => {
  const environment = await environmentInside();
  assert.equal(environment['PGDATABASE'], DATABASE_NAME);
  assert.equal(environment['PGPASSWORD'], secretValue);
});
