// The workload runner for real, on Docker, with the fixture workload image.
//   - A hostile suite's every attempt to reach an undeclared origin is blocked and recorded with
//     its channel: Node's fetch, a raw socket that ignores the proxy (seen only as a DNS lookup,
//     so recorded as "process"), a metadata name and address, an IPv6 form of loopback, and a
//     browser's request, WebSocket and beacon. Its own app on loopback still works (AC-05).
//   - A test printing its whole environment sees only the declared variables, Revisum's own and
//     the image's own: no CI token, cloud credential or GITHUB_* value (AC-06).
//   - Where egress cannot be enforced, the suite is refused with egress-unenforceable and no suite
//     code runs: it writes no report, and no container of the team's image is started (AC-07).
//   - Declared arguments that look like shell syntax reach the process as literal text (AC-12).
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createSecret, failure, type EgressEvent, type SecretName } from '@revisum/contracts';
import { dockerCliEngine, type ContainerEngine } from '@revisum/runner';
import { DECLARED_SECRET } from '../unit/engine/evidence-examples.ts';
import { fakeSecretValue } from '../unit/engine/secret-examples.ts';
import { hostOf } from '../unit/runner/runner-examples.ts';
import { DECLARED_LITERAL, DISTINCTIVE_HOST_VALUES, isRevisumOwnName } from '../unit/runner/workload-examples.ts';
import { dockerIds, newIds } from './isolated-run.ts';
import { filesIn, fixtureWorkloadImage, imageEnvironmentNames, printedJson, runFixtureSuite, runInWorkload } from './workload-run.ts';

const TIMEOUT = 600_000;
const CHANNELS = ['page', 'websocket', 'worker', 'popup', 'redirect', 'beacon', 'unattributed', 'process'];

let image: string;
before(async () => { image = await fixtureWorkloadImage(); }, { timeout: TIMEOUT });

// ---- Egress ------------------------------------------------------------------------------------------

type Attempts = { readonly seen: Readonly<Record<string, unknown>>; readonly events: readonly EgressEvent[] };
let attempts: Attempts | undefined;

// The egress attempts run once; every egress test reads what they saw and what was recorded.
async function egressAttempts(): Promise<Attempts> {
  if (attempts === undefined) {
    const outcome = await runInWorkload(image, { argv: ['node', 'egress-attempts.mjs'], timeoutMilliseconds: 300_000 });
    assert.equal(outcome.exitCode, 0, `the egress attempts failed to run: ${JSON.stringify(outcome)}`);
    const seen = printedJson(outcome);
    assert.ok(typeof seen === 'object' && seen !== null);
    attempts = { seen: seen as Readonly<Record<string, unknown>>, events: outcome.egressEvents };
  }
  return attempts;
}

const eventsFor = (events: readonly EgressEvent[], host: string): readonly EgressEvent[] =>
  events.filter((event) => hostOf(String(event.origin)) === host);

const UNDECLARED_HOSTS = [
  { attempt: 'Node fetch', host: 'fetch.invalid' },
  { attempt: 'a raw TCP socket', host: 'socket.invalid' },
  { attempt: 'a cloud metadata name', host: 'metadata.google.internal' },
  { attempt: 'the cloud metadata address', host: '169.254.169.254' },
  { attempt: 'a browser page\'s request', host: 'page.invalid' },
  { attempt: 'a browser WebSocket', host: 'websocket.invalid' },
  { attempt: 'a browser beacon', host: 'beacon.invalid' },
];

for (const { attempt, host } of UNDECLARED_HOSTS) {
  test(`${attempt} to ${host} is blocked and recorded, and never allowed`, { criterion: 'AC-SPEC-35-05', timeout: TIMEOUT }, async () => {
    const { events } = await egressAttempts();
    const recorded = eventsFor(events, host);
    assert.ok(recorded.length >= 1, `nothing was recorded for ${host}: ${JSON.stringify(events)}`);
    assert.ok(recorded.every((event) => event.decision === 'blocked'), JSON.stringify(recorded));
    assert.ok(recorded.every((event) => CHANNELS.includes(event.channel)), JSON.stringify(recorded));
  });
}

test('a raw socket that ignores the proxy is recorded with the channel process', { criterion: 'AC-SPEC-35-05', timeout: TIMEOUT }, async () => {
  const { events } = await egressAttempts();
  assert.ok(eventsFor(events, 'socket.invalid').some((event) => event.channel === 'process'), JSON.stringify(events));
});

test('an IPv6 form of loopback is blocked and recorded, not treated as the container\'s own loopback', { criterion: 'AC-SPEC-35-05', timeout: TIMEOUT }, async () => {
  const { events } = await egressAttempts();
  const recorded = events.filter((event) => hostOf(String(event.origin)).startsWith('::ffff:'));
  assert.ok(recorded.length >= 1 && recorded.every((event) => event.decision === 'blocked'), JSON.stringify(events));
});

test('no attempt reached an undeclared origin, from the suite\'s own view', { criterion: 'AC-SPEC-35-05', timeout: TIMEOUT }, async () => {
  const { seen } = await egressAttempts();
  for (const name of ['node-fetch', 'metadata-name', 'metadata-address', 'ipv6-loopback']) {
    assert.ok(!/^status 2\d\d$/.test(String(seen[name])), `${name} got ${String(seen[name])}`);
  }
  assert.notEqual(seen['raw-socket'], 'connected');
  const browser = seen['browser'];
  assert.ok(typeof browser === 'object' && browser !== null, JSON.stringify(seen));
  assert.notEqual(Reflect.get(browser, 'page'), 'reached');
  assert.notEqual(Reflect.get(browser, 'websocket'), 'open');
});

test('counter-example: the suite\'s own app on loopback answers, and is not recorded as egress', { criterion: 'AC-SPEC-35-05', timeout: TIMEOUT }, async () => {
  const { seen, events } = await egressAttempts();
  assert.equal(seen['own-app'], 'status 200');
  assert.deepEqual(eventsFor(events, '127.0.0.1'), []);
});

// ---- The environment ------------------------------------------------------------------------------------

async function environmentInside(secretValue: string): Promise<Readonly<Record<string, string>>> {
  const secret = createSecret(DECLARED_SECRET as SecretName, secretValue);
  const outcome = await runInWorkload(image, {
    argv: ['node', '-e', 'console.log(JSON.stringify(process.env))'],
    environment: [DECLARED_LITERAL, { name: DECLARED_SECRET, value: secret }],
  });
  return printedJson(outcome) as Readonly<Record<string, string>>;
}

test('a test printing its environment sees only the declared variables, Revisum\'s own and the image\'s own', { criterion: 'AC-SPEC-35-06', timeout: TIMEOUT }, async () => {
  const inside = await environmentInside(fakeSecretValue());
  const imageOwn = new Set([...await imageEnvironmentNames(image), 'HOSTNAME']);
  const unexpected = Object.keys(inside).filter((name) =>
    name !== DECLARED_LITERAL.name && name !== DECLARED_SECRET && !isRevisumOwnName(name) && !imageOwn.has(name));
  assert.deepEqual(unexpected, []);
});

test('no CI token, cloud credential or GITHUB_* value is in the environment inside', { criterion: 'AC-SPEC-35-06', timeout: TIMEOUT }, async () => {
  const inside = await environmentInside(fakeSecretValue());
  assert.deepEqual(Object.keys(inside).filter((name) => name.startsWith('GITHUB_') || /^(AWS_|AZURE_|GOOGLE_|GCP_|NPM_|ACTIONS_)/.test(name)), []);
  const values = Object.values(inside);
  for (const value of DISTINCTIVE_HOST_VALUES) assert.ok(!values.some((text) => text.includes(value)), 'a host credential\'s value is inside');
});

test('counter-example: the declared literal and the declared secret\'s value are inside', { criterion: 'AC-SPEC-35-06', timeout: TIMEOUT }, async () => {
  const secretValue = fakeSecretValue();
  const inside = await environmentInside(secretValue);
  assert.equal(inside[DECLARED_LITERAL.name], DECLARED_LITERAL.value);
  assert.equal(inside[DECLARED_SECRET], secretValue);
});

// ---- Egress that cannot be enforced ------------------------------------------------------------------------

// The Docker engine with one of its answers changed, as on a host that cannot enforce egress, and
// a record of every image a container was started from.
function engineWhere(change: 'no-internal-network' | 'probe-reaches'): ContainerEngine & { readonly images: readonly string[] } {
  const real = dockerCliEngine();
  const images: string[] = [];
  return {
    ...real,
    images,
    async createNetwork(name, options) {
      if (change === 'no-internal-network' && options.internal) return failure({ detail: 'this host cannot make a network with no route out' });
      return real.createNetwork(name, options);
    },
    async probeEgress(containerId, targets) {
      return change === 'probe-reaches' ? 'reached' : real.probeEgress(containerId, targets);
    },
    async startContainer(options) {
      images.push(options.image);
      return real.startContainer(options);
    },
  };
}

for (const change of ['no-internal-network', 'probe-reaches'] as const) {
  test(`with egress unenforceable (${change}), the suite is refused with egress-unenforceable and no suite code runs`, { criterion: 'AC-SPEC-35-07', timeout: TIMEOUT }, async () => {
    const containersBefore = dockerIds('containers');
    const networksBefore = dockerIds('networks');
    const engine = engineWhere(change);
    const { result, outputDirectory } = await runFixtureSuite(image, fakeSecretValue(), engine);
    assert.equal(result.state, 'Refused');
    assert.equal(result.refusal?.code, 'egress-unenforceable');
    assert.ok(!engine.images.includes(image), 'a container of the team\'s image was started');
    assert.deepEqual(filesIn(outputDirectory), [], 'the suite wrote output');
    assert.deepEqual(newIds(containersBefore, dockerIds('containers')), []);
    assert.deepEqual(newIds(networksBefore, dockerIds('networks')), []);
  });
}

test('counter-example: with egress enforced, the same suite runs and writes its report', { criterion: 'AC-SPEC-35-07', timeout: TIMEOUT }, async () => {
  const { result, outputDirectory } = await runFixtureSuite(image, fakeSecretValue());
  assert.notEqual(result.state, 'Refused');
  assert.ok(filesIn(outputDirectory).length >= 1, 'the suite wrote nothing');
});

// ---- The command -------------------------------------------------------------------------------------------

test('declared arguments of "; rm -rf /" and "$(id)" reach the process as literal text, with no shell', { criterion: 'AC-SPEC-35-12', timeout: TIMEOUT }, async () => {
  const outcome = await runInWorkload(image, { argv: ['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '; rm -rf /', '$(id)'] });
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(printedJson(outcome), ['; rm -rf /', '$(id)']);
});
