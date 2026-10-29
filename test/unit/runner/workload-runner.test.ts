// The workload runner on a fake container engine, so these run in npm run check with no Docker.
// It must never start the team's image without egress control: when the host cannot make a
// network with no route out, when the proxy container does not start, or when a probe from inside
// reaches an address outside, run() returns egress-unenforceable before any container of the
// team's image exists, and removes what it made. When egress is enforced, the team's container
// joins only the run's internal network, sends every process through the proxy while loopback
// stays local, does not run as root, and gets an environment of the declared variables and
// Revisum's own, never the host's. Its argument vector reaches the engine as separate strings.
// The counter-examples run the same requests on a host where egress is enforced, so each check
// can be seen to find a container of the team's image when there is one.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSecret, type SecretName } from '@revisum/contracts';
import { fakeContainerEngine, type FakeContainerEngine, type FakeEngineSettings } from './fake-container-engine.ts';
import { PINNED_IMAGE_ID } from './runner-examples.ts';
import {
  DECLARED_LITERAL, DECLARED_SECRET_NAME, DISTINCTIVE_HOST_VALUES, HOST_CREDENTIALS, PRESENT_IMAGES, SUITE_COMMAND, TEAM_IMAGE_ID,
  errorCode, isRevisumOwnName, runnerOn, teamContainers, withSeededHost, workloadRequest, type RequestFields,
} from './workload-examples.ts';

const ENFORCING_HOST: FakeEngineSettings = { localImageId: PINNED_IMAGE_ID, internalNetworks: true, probe: 'blocked', images: PRESENT_IMAGES };

// Runs one request on a fake engine with these settings. A run that egress allows may still stop
// once its container is started, since the fake engine never runs anything; what it asked the
// engine for is what these tests read.
async function runOn(settings: FakeEngineSettings, fields: RequestFields = {}) {
  const engine = fakeContainerEngine(settings);
  const { runner } = runnerOn(engine);
  const outcome = await withSeededHost(() => runner.run(workloadRequest(fields)).catch((error: unknown) => ({ thrown: error })));
  return { engine, outcome };
}

function nothingLeft(engine: FakeContainerEngine): void {
  assert.deepEqual(engine.runningContainers(), [], 'a container was left running');
  assert.deepEqual(engine.existingNetworks(), [], 'a network was left behind');
}

// The one container of the team's image that an enforcing host starts.
async function teamContainer(fields: RequestFields = {}) {
  const { engine } = await runOn(ENFORCING_HOST, fields);
  const containers = teamContainers(engine.started);
  assert.equal(containers.length, 1, `expected one container of the team's image, got ${containers.length}`);
  const [options] = containers;
  assert.ok(options !== undefined);
  return { engine, options };
}

// ---- Egress that cannot be enforced -------------------------------------------------------------------

const UNENFORCEABLE_HOSTS: readonly { readonly title: string; readonly settings: FakeEngineSettings }[] = [
  { title: 'a host whose Docker cannot make a network with no route out', settings: { ...ENFORCING_HOST, internalNetworks: false } },
  { title: 'a host where a probe from inside reaches an address outside', settings: { ...ENFORCING_HOST, probe: 'reached' } },
  {
    title: 'a host where the proxy container does not start',
    settings: { ...ENFORCING_HOST, failsToStart: (options) => options.image !== TEAM_IMAGE_ID },
  },
];

for (const { title, settings } of UNENFORCEABLE_HOSTS) {
  test(`on ${title}, the workload is refused with egress-unenforceable`, { criterion: 'AC-SPEC-35-07' }, async () => {
    const { outcome } = await runOn(settings);
    assert.ok(!('thrown' in outcome), `run threw instead of refusing: ${String('thrown' in outcome ? outcome.thrown : '')}`);
    assert.equal(errorCode(outcome), 'egress-unenforceable');
  });

  test(`on ${title}, no container of the team's image is started and nothing is left behind`, { criterion: 'AC-SPEC-35-07' }, async () => {
    const { engine } = await runOn(settings);
    assert.deepEqual(teamContainers(engine.started), []);
    assert.ok(!engine.executed.some((run) => run.command.includes('playwright')), JSON.stringify(engine.executed));
    nothingLeft(engine);
  });
}

test('counter-example: on a host that enforces egress, a container of the team\'s image is started', { criterion: 'AC-SPEC-35-07' }, async () => {
  const { engine } = await runOn(ENFORCING_HOST);
  assert.equal(teamContainers(engine.started).length, 1);
});

test('the egress probe has run before the team\'s image is started', { criterion: 'AC-SPEC-35-07' }, async () => {
  const { engine } = await runOn(ENFORCING_HOST);
  const teamStart = engine.started.findIndex((options) => options.image === TEAM_IMAGE_ID);
  assert.ok(teamStart >= 0, 'the team\'s image was never started');
  // The calls list names every startContainer in order, so the team's is the (teamStart + 1)th.
  const startCalls = engine.calls.flatMap((call, index) => (call === 'startContainer' ? [index] : []));
  const probeCall = engine.calls.indexOf('probeEgress');
  assert.ok(probeCall >= 0, `no egress probe was made: ${JSON.stringify(engine.calls)}`);
  assert.ok(probeCall < (startCalls[teamStart] ?? -1), `the team's image started before the probe: ${JSON.stringify(engine.calls)}`);
});

// ---- The network and the proxy -------------------------------------------------------------------------

test('the team\'s container joins only the run\'s network, which has no route out', { criterion: 'AC-SPEC-35-05' }, async () => {
  const { engine, options } = await teamContainer();
  assert.equal(options.networks.length, 1, JSON.stringify(options.networks));
  const network = engine.createdNetworks.find((created) => created.name === options.networks[0]);
  assert.deepEqual(network, { name: options.networks[0], internal: true });
});

test('every process in the team\'s container is pointed at the run\'s proxy, with loopback kept local', { criterion: 'AC-SPEC-35-05' }, async () => {
  const { engine, options } = await teamContainer();
  const environment = options.environment;
  const proxy = environment['HTTP_PROXY'];
  assert.ok(proxy !== undefined && proxy !== '', 'HTTP_PROXY is not set');
  assert.equal(environment['HTTPS_PROXY'], proxy);
  assert.equal(environment['NO_PROXY'], 'localhost,127.0.0.1,::1');
  // Node's own fetch follows the proxy variables only when told to.
  assert.equal(environment['NODE_USE_ENV_PROXY'], '1');
  const proxyHost = new URL(proxy).hostname;
  assert.ok(engine.started.some((other) => other.image !== TEAM_IMAGE_ID && other.name === proxyHost),
    `no proxy container named ${proxyHost} was started: ${JSON.stringify(engine.started.map((other) => other.name))}`);
});

test('the proxy container also joins the run\'s network, so the team\'s container can reach it', { criterion: 'AC-SPEC-35-05' }, async () => {
  const { engine, options } = await teamContainer();
  const proxyHost = new URL(options.environment['HTTP_PROXY'] ?? 'http://missing').hostname;
  const proxy = engine.started.find((other) => other.name === proxyHost);
  assert.ok(proxy !== undefined, 'no proxy container');
  assert.ok(proxy.networks.includes(options.networks[0] ?? ''), JSON.stringify(proxy.networks));
});

test('the team\'s container never runs as root', { criterion: 'AC-SPEC-35-05' }, async () => {
  const { options } = await teamContainer();
  const user = options.user.trim();
  assert.ok(user !== '' && !/^(root|0)(:|$)/.test(user), `the container runs as "${options.user}"`);
  assert.ok(options.seccompProfile !== '', 'no seccomp profile');
});

// ---- The environment ----------------------------------------------------------------------------------

test('the team\'s container gets only the declared variables and Revisum\'s own', { criterion: 'AC-SPEC-35-06' }, async () => {
  const { options } = await teamContainer();
  const unexpected = Object.keys(options.environment).filter((name) => name !== DECLARED_LITERAL.name && !isRevisumOwnName(name));
  assert.deepEqual(unexpected, []);
});

test('no seeded host credential reaches the team\'s container, by name or by value', { criterion: 'AC-SPEC-35-06' }, async () => {
  const { options } = await teamContainer();
  for (const name of Object.keys(HOST_CREDENTIALS)) assert.ok(!Object.hasOwn(options.environment, name), `${name} reached the container`);
  const values = Object.values(options.environment);
  for (const value of DISTINCTIVE_HOST_VALUES) assert.ok(!values.some((text) => text.includes(value)), 'a host credential\'s value reached the container');
  assert.deepEqual(Object.keys(options.environment).filter((name) => name.startsWith('GITHUB_')), []);
});

test('counter-example: the declared literal and the declared secret\'s value do reach the team\'s container', { criterion: 'AC-SPEC-35-06' }, async () => {
  const secretValue = `shop-token-${'x7'.repeat(12)}`;
  const secret = createSecret(DECLARED_SECRET_NAME as SecretName, secretValue);
  const { options } = await teamContainer({ environment: [DECLARED_LITERAL, { name: DECLARED_SECRET_NAME, value: secret }] });
  assert.equal(options.environment[DECLARED_LITERAL.name], DECLARED_LITERAL.value);
  // The runner is where a secret is revealed, as the container's environment is written.
  assert.equal(options.environment[DECLARED_SECRET_NAME], secretValue);
});

// ---- The command ----------------------------------------------------------------------------------------

const HOSTILE_COMMAND = [...SUITE_COMMAND, '; rm -rf /', '$(id)'];

// Every argument vector the engine was given: the command of each container started from the
// team's image, and each command run inside one.
function commandsGiven(engine: FakeContainerEngine): readonly (readonly string[])[] {
  const teamIds = new Set(engine.started.flatMap((options, index) => (options.image === TEAM_IMAGE_ID ? [`fake-container-${index + 1}`] : [])));
  return [...teamContainers(engine.started).map((options) => options.command), ...engine.executed.filter((run) => teamIds.has(run.containerId)).map((run) => run.command)];
}

const holdsInOrder = (command: readonly string[], argv: readonly string[]): boolean =>
  command.some((_, start) => argv.every((word, offset) => command[start + offset] === word));

test('the argument vector reaches the team\'s container as separate strings, shell text unchanged', { criterion: 'AC-SPEC-35-12' }, async () => {
  const { engine } = await runOn(ENFORCING_HOST, { argv: HOSTILE_COMMAND });
  const commands = commandsGiven(engine);
  assert.ok(commands.some((command) => holdsInOrder(command, HOSTILE_COMMAND)), `the argument vector was changed: ${JSON.stringify(commands)}`);
});

test('the argument vector is never handed to a shell', { criterion: 'AC-SPEC-35-12' }, async () => {
  const { engine } = await runOn(ENFORCING_HOST, { argv: HOSTILE_COMMAND });
  for (const command of commandsGiven(engine)) {
    assert.ok(!command.includes('-c') || !command.some((word) => /(^|\/)(sh|bash|dash|ash|zsh)$/.test(word)), `a shell runs: ${JSON.stringify(command)}`);
    assert.ok(command.filter((word) => word.includes('rm -rf')).every((word) => word === '; rm -rf /'), `an argument was joined: ${JSON.stringify(command)}`);
  }
});
