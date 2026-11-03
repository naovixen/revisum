// Inside a real run container:
//   - the channels of egress events come from the browser's records, printed by the process inside
//     the container, so a WebSocket's event says websocket, not only its origin and decision;
//   - a direct connection that ignores the proxy, to a cloud metadata address, the Docker gateway or
//     host.docker.internal, finds nothing. A service really is listening on the Docker host for
//     these probes, and an ordinary container does reach it, and the same probe does reach the
//     run's proxy: the counter-examples that show the probe can succeed;
//   - cutting the gateway off does not cut the run off: the runner still reports the isolated level,
//     the proxy still carries a declared request out, and the network's peers still reach each other;
//   - WebRTC reaches nothing outside, from a run and from a browser whose WebRTC nothing has turned
//     off. Witnesses at the addresses it aims for are the only ones who can say so: a page never
//     hears whether a STUN datagram landed. The same page does reach a witness on the run's own
//     network, and an ordinary container does reach the outside witnesses: the counter-examples.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from 'node:net';
import { platform } from 'node:os';
import { after, before, describe, test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { PRODUCT, type BrowserRequestRecord } from '@revisum/contracts';
import { runDocker } from '@revisum/runner';
import { WEBRTC_CHANNELS } from '../proofs/EgressChannels.ts';
import { Arrival, startRecordingOrigin, type RecordingOrigin } from '../proofs/StartRecordingOrigin.ts';
import { declaredService, egressPolicy, hostOf } from '../unit/runner/runner-examples.ts';
import { attemptWebRtcInside, WebRtcBrowser, BARE_BROWSER_STATE } from './AttemptWebRtcInside.ts';
import { jsonInside, pinnedRunImage, startIsolatedRun, type IsolatedRun } from './isolated-run.ts';

const TIMEOUT = 600_000;
const OUTSIDE_HOST = 'outside.invalid';

// A service listening on every interface of the Docker host, in a container on the host's own
// network. Without one, a probe of the gateway would find nothing even with a route to it.
type DockerHostService = { readonly name: string; readonly image: string; readonly port: number };

// Letters only, so it can be searched for in what comes back.
const DOCKER_HOST_SERVICE_BODY = 'dockerhostservicebody';
const DOCKER_HOST_SERVICE_NAME = 'docker-host-service';

const dockerHostServiceScript = `
  const server = require('node:http').createServer((request, response) => response.end(${JSON.stringify(DOCKER_HOST_SERVICE_BODY)}));
  server.listen(0, '0.0.0.0', () => console.log('listening ' + server.address().port));`;

async function startDockerHostService(): Promise<DockerHostService> {
  const image = await pinnedRunImage();
  const name = `${PRODUCT.name}-host-service-${randomBytes(6).toString('hex')}`;
  const started = await runDocker([
    'run', '--detach', '--rm', '--name', name, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', 'node', image, 'node', '-e', dockerHostServiceScript,
  ]);
  assert.equal(started.status, 0, `the service on the Docker host did not start: ${started.stderr}`);
  for (let tries = 0; tries < 50; tries++) {
    const port = /listening (\d+)/.exec((await runDocker(['logs', name])).stdout)?.[1];
    if (port !== undefined) return { name, image, port: Number(port) };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await runDocker(['stop', '--time', '1', name]);
  assert.fail('the service on the Docker host never said it was listening');
}

// A service on the machine host.docker.internal names under Docker Desktop: the machine running
// Docker Desktop, where a loopback listener answers it and raises no firewall prompt. On Linux the
// tests use the service on the Docker host's own network instead (see machineServicePort).
async function startMachineService(): Promise<TcpServer> {
  const server = createTcpServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// The address of the default bridge's gateway, which the proxy reaches and the run container must not.
async function gatewayOf(network: string): Promise<string> {
  const inspected = await runDocker(['network', 'inspect', network, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}']);
  assert.equal(inspected.status, 0, inspected.stderr);
  const subnet = /(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\/\d+/.exec(inspected.stdout);
  assert.ok(subnet?.[1] !== undefined, `the network ${network} has an IPv4 subnet: ${inspected.stdout}`);
  // The subnet's first host, which is where Docker puts the gateway. A network made with no gateway
  // at all still has this address to try, and finds nothing.
  return `${subnet[1]}.1`;
}

let dockerHostService: DockerHostService;
let dockerHostServiceOrigin: string;
let machineService: TcpServer;
let run: IsolatedRun;
before(async () => {
  dockerHostService = await startDockerHostService();
  machineService = await startMachineService();
  dockerHostServiceOrigin = `http://${await gatewayOf('bridge')}:${dockerHostService.port}`;
  run = await startIsolatedRun({
    // The plan run below needs its script, the test helpers it imports and the fixture app.
    inputs: ['test', 'fixtures'],
    // The proxy, on the default bridge, may reach the Docker host's service, on a private address.
    policy: egressPolicy({ allowOrigins: [dockerHostServiceOrigin], allowServices: [DOCKER_HOST_SERVICE_NAME] }),
    services: [declaredService(DOCKER_HOST_SERVICE_NAME, dockerHostServiceOrigin, true)],
  });
}, { timeout: TIMEOUT });
after(async () => {
  await run?.stop();
  if (dockerHostService !== undefined) await runDocker(['stop', '--time', '1', dockerHostService.name]);
  machineService?.close();
}, { timeout: TIMEOUT });

// ---- The browser's records --------------------------------------------------------------------------

type PrintedRecords = { readonly browserRecords: readonly BrowserRequestRecord[]; readonly fixtureOrigin: string };
let printedRecords: PrintedRecords | undefined;

// The plan runs once; each test reads what it printed and what the proxy decided.
async function planRecords(): Promise<PrintedRecords> {
  if (printedRecords !== undefined) return printedRecords;
  const outcome = await run.handle.exec(['node', 'test/containers/plan-run-inside.ts']);
  assert.equal(outcome.exitCode, 0, `the plan run inside the container failed: ${outcome.stderr}`);
  const lines = outcome.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(lines.at(-1) ?? 'null'), { state: 'Passed' });
  printedRecords = JSON.parse(lines.at(-2) ?? 'null') as PrintedRecords;
  return printedRecords;
}

test('a WebSocket to an undeclared origin is blocked and its event says websocket', { timeout: TIMEOUT }, async () => {
  const { browserRecords, fixtureOrigin } = await planRecords();
  const outside = run.handle.egressEvents(browserRecords, [fixtureOrigin]).filter((event) => hostOf(event.origin) === OUTSIDE_HOST);
  assert.ok(outside.some((event) => event.channel === 'websocket' && event.decision === 'blocked'), JSON.stringify(outside));
  assert.ok(outside.every((event) => event.decision === 'blocked'), JSON.stringify(outside));
});

test('the proxy\'s own decision for that WebSocket is read back from its container', { timeout: TIMEOUT }, async () => {
  await planRecords();
  const outside = run.handle.proxyDecisions().filter((decision) => hostOf(decision.origin) === OUTSIDE_HOST);
  assert.ok(outside.length >= 1, JSON.stringify(run.handle.proxyDecisions()));
  assert.ok(outside.every((decision) => decision.decision === 'blocked'), JSON.stringify(outside));
});

test('counter-example: without the browser\'s records the same decision has no channel, so the channel came from them', { timeout: TIMEOUT }, async () => {
  await planRecords();
  const outside = run.handle.egressEvents().filter((event) => hostOf(event.origin) === OUTSIDE_HOST);
  assert.ok(outside.length >= 1, JSON.stringify(run.handle.egressEvents()));
  assert.ok(outside.every((event) => event.channel === 'unattributed'), JSON.stringify(outside));
});

test('the page\'s request to its own loopback, which never reaches the proxy, is allowed only because the run names it direct', { timeout: TIMEOUT }, async () => {
  const { browserRecords, fixtureOrigin } = await planRecords();
  const named = run.handle.egressEvents(browserRecords, [fixtureOrigin]).filter((event) => event.origin === fixtureOrigin);
  assert.ok(named.some((event) => event.channel === 'page' && event.decision === 'allowed'), JSON.stringify(named));
  const unnamed = run.handle.egressEvents(browserRecords).filter((event) => event.origin === fixtureOrigin);
  assert.ok(unnamed.length >= 1 && unnamed.every((event) => event.decision === 'blocked'), JSON.stringify(unnamed));
});

// ---- Direct connections -----------------------------------------------------------------------------

// Tries a direct TCP connection from inside the container, ignoring the proxy, and prints whether
// it was reached, within a few seconds.
const directConnection = (host: string, port: number): string => `
  const socket = require('node:net').connect({ host: ${JSON.stringify(host)}, port: ${port} });
  const finish = (outcome) => { console.log(JSON.stringify(outcome)); socket.destroy(); process.exit(0); };
  socket.setTimeout(4000, () => finish('blocked'));
  socket.on('connect', () => finish('reached'));
  socket.on('error', () => finish('blocked'));`;

const METADATA_TARGETS = [
  { host: '169.254.169.254', port: 80 },
  { host: '100.100.100.200', port: 80 },
  { host: 'fd00:ec2::254', port: 80 },
  { host: 'metadata.google.internal', port: 80 },
];

for (const { host, port } of METADATA_TARGETS) {
  test(`a direct connection from inside to the metadata address ${host}:${port} finds nothing`, { timeout: TIMEOUT }, async () => {
    assert.equal(await jsonInside(run.handle, directConnection(host, port)), 'blocked');
  });
}

for (const network of ['the run\'s own network', 'the default bridge']) {
  test(`a direct connection from inside to the gateway of ${network} does not reach a service on the Docker host`, { timeout: TIMEOUT }, async () => {
    const gateway = await gatewayOf(network === 'the default bridge' ? 'bridge' : `${run.handle.runId}-network`);
    assert.equal(await jsonInside(run.handle, directConnection(gateway, dockerHostService.port)), 'blocked', `${gateway}:${dockerHostService.port}`);
  });
}

test('counter-example: an ordinary container on the default bridge does reach that service through its gateway', { timeout: TIMEOUT }, async () => {
  const gateway = await gatewayOf('bridge');
  const probed = await runDocker(['run', '--rm', '--network', 'bridge', '--user', 'node', dockerHostService.image, 'node', '-e', directConnection(gateway, dockerHostService.port)]);
  assert.equal(probed.status, 0, probed.stderr);
  assert.equal(JSON.parse(probed.stdout.trim()), 'reached', `${gateway}:${dockerHostService.port}`);
});

// On Linux the name leads to the Docker host. The test process may itself be in a container, as in
// CI, so only a service on the host's own network is sure to be there.
const machineServicePort = (): number => (
  platform() === 'linux' ? dockerHostService.port : (machineService.address() as AddressInfo).port
);

// A name that does not resolve counts as blocked too: the script's connection simply fails.
test('a direct connection from inside to host.docker.internal does not reach a service on that machine', { timeout: TIMEOUT }, async () => {
  assert.equal(await jsonInside(run.handle, directConnection('host.docker.internal', machineServicePort())), 'blocked');
});

test('counter-example: an ordinary container on the default bridge does reach that service through host.docker.internal', { timeout: TIMEOUT }, async () => {
  const probed = await runDocker([
    'run', '--rm', '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway', '--user', 'node', dockerHostService.image,
    'node', '-e', directConnection('host.docker.internal', machineServicePort()),
  ]);
  assert.equal(probed.status, 0, probed.stderr);
  assert.equal(JSON.parse(probed.stdout.trim()), 'reached', `host.docker.internal:${machineServicePort()}`);
});

test('counter-example: the same probe reaches the run\'s proxy, which is on the container\'s network', { timeout: TIMEOUT }, async () => {
  const proxyAddress = await jsonInside(run.handle, 'console.log(JSON.stringify(process.env.HTTP_PROXY ?? ""))');
  assert.ok(typeof proxyAddress === 'string' && proxyAddress !== '', 'the run container is told where its proxy is');
  const proxy = new URL(proxyAddress);
  assert.equal(await jsonInside(run.handle, directConnection(proxy.hostname, Number(proxy.port))), 'reached');
});

// ---- The run still works on its network ------------------------------------------------------------

test('the runner reports the isolated level on the run\'s network, with nothing logged as unenforceable', { timeout: TIMEOUT }, () => {
  assert.equal(run.runner.guaranteeLevel(), 'isolated');
  assert.ok(!run.logged.some((entry) => entry.code === 'egress-unenforceable'), JSON.stringify(run.logged));
});

// Asks the run's proxy for a URL, from inside the run container, and prints the answer.
const throughProxy = (url: string): string => `
  const proxy = new URL(process.env.SERVICE_PROXY ?? process.env.HTTP_PROXY);
  const target = new URL(${JSON.stringify(url)});
  const outgoing = require('node:http').request({ host: proxy.hostname, port: proxy.port, path: target.href, headers: { host: target.host } }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => console.log(JSON.stringify({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })));
  });
  outgoing.on('error', (error) => { console.error(error.message); process.exit(1); });
  outgoing.end();`;

test('the proxy still carries a declared request out of the run\'s network', { timeout: TIMEOUT }, async () => {
  assert.deepEqual(await jsonInside(run.handle, throughProxy(`${dockerHostServiceOrigin}/`)), { status: 200, body: DOCKER_HOST_SERVICE_BODY });
});

test('counter-example: the proxy still refuses an undeclared request from the run\'s network', { timeout: TIMEOUT }, async () => {
  const answer = await jsonInside(run.handle, throughProxy('http://undeclared.invalid/'));
  assert.equal((answer as { readonly status: number }).status, 403);
});

test('peers on the run\'s network still reach each other by name, in both directions', { timeout: TIMEOUT }, async () => {
  const peerPort = 4500;
  const runContainer = `${run.handle.runId}-run`;
  const proxyContainer = `${run.handle.runId}-proxy`;
  const listening = await runDocker([
    'exec', '--detach', runContainer, 'node', '-e', `require('node:net').createServer((socket) => socket.end()).listen(${peerPort}, '0.0.0.0')`,
  ]);
  assert.equal(listening.status, 0, listening.stderr);
  let fromProxy: unknown = null;
  for (let tries = 0; tries < 20 && fromProxy !== 'reached'; tries++) {
    const probed = await runDocker(['exec', proxyContainer, 'node', '-e', directConnection(runContainer, peerPort)]);
    assert.equal(probed.status, 0, probed.stderr);
    fromProxy = JSON.parse(probed.stdout.trim());
    if (fromProxy !== 'reached') await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(fromProxy, 'reached', 'the proxy reached the run container');
  assert.equal(await jsonInside(run.handle, directConnection(proxyContainer, 3128)), 'reached', 'the run container reached the proxy');
});

// ---- WebRTC -----------------------------------------------------------------------------------------

// Something at an address that notes each datagram and connection it gets. A datagram has no answer,
// so this record is the only way to see one land.
type WebRtcWitness = {
  readonly hostname: string;
  readonly port: number;
  readonly datagramPort: number;
  arrivals(): Promise<readonly string[]>;
};

type WitnessContainer = WebRtcWitness & { stop(): Promise<void> };

const WITNESS_LISTENING = /listening (\d+) (\d+)/;
const WITNESS_ARRIVED = /^arrived (\S+)$/gm;

const witnessScript = `
  const stream = require('node:net').createServer((socket) => {
    console.log('arrived ${Arrival.Connection}');
    socket.on('error', () => {});
    socket.resume();
  });
  const datagrams = require('node:dgram').createSocket('udp4');
  datagrams.on('message', () => console.log('arrived ${Arrival.Datagram}'));
  stream.listen(0, '0.0.0.0', () => datagrams.bind(0, '0.0.0.0', () => {
    console.log('listening ' + stream.address().port + ' ' + datagrams.address().port);
  }));`;

const HOST_NETWORK = 'host';

// A witness in a container of its own, on the network named.
async function startWitnessContainer(network: string): Promise<WitnessContainer> {
  const image = await pinnedRunImage();
  const name = `${PRODUCT.name}-webrtc-witness-${randomBytes(6).toString('hex')}`;
  const started = await runDocker([
    'run', '--detach', '--rm', '--name', name, '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', 'node', image, 'node', '-e', witnessScript,
  ]);
  assert.equal(started.status, 0, `the witness did not start: ${started.stderr}`);
  const logs = async (): Promise<string> => (await runDocker(['logs', name])).stdout;
  let listening: RegExpExecArray | null = null;
  for (let tries = 0; tries < 50 && listening === null; tries++) {
    listening = WITNESS_LISTENING.exec(await logs());
    if (listening === null) { await pause(200); }
  }
  assert.ok(listening !== null, 'the witness never said it was listening');
  const inspected = await runDocker(['inspect', name, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']);
  assert.equal(inspected.status, 0, inspected.stderr);
  return {
    hostname: inspected.stdout.trim(),
    port: Number(listening[1]),
    datagramPort: Number(listening[2]),
    arrivals: async () => [...(await logs()).matchAll(WITNESS_ARRIVED)].flatMap((arrived) => arrived[1] ?? []),
    stop: async () => { await runDocker(['stop', '--time', '1', name]); },
  };
}

const atAddress = (witness: WebRtcWitness, hostname: string): WebRtcWitness => ({ ...witness, hostname });

// The address this machine's Docker Desktop gives host.docker.internal, as an ordinary container sees it.
async function machineAddress(image: string): Promise<string> {
  const looked = await runDocker([
    'run', '--rm', '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway', '--user', 'node', image,
    'node', '-e', `require('node:dns').lookup('host.docker.internal', (error, address) => console.log(address));`,
  ]);
  assert.equal(looked.status, 0, looked.stderr);
  return looked.stdout.trim();
}

const machineWitness = (recording: RecordingOrigin, hostname: string): WebRtcWitness => ({
  hostname,
  port: recording.port,
  datagramPort: recording.datagramPort,
  arrivals: () => Promise.resolve(recording.arrivals()),
});

// Sends one datagram and opens one connection, without a browser, and prints what the system said.
const directDatagramAndConnection = ({ hostname, port, datagramPort }: WebRtcWitness): string => `
  const socket = require('node:dgram').createSocket('udp4');
  socket.send('probe', ${datagramPort}, ${JSON.stringify(hostname)}, (error) => {
    socket.close();
    const finish = (connection) => { console.log(JSON.stringify({ datagram: error === null ? 'sent' : error.code, connection })); process.exit(0); };
    const stream = require('node:net').connect({ host: ${JSON.stringify(hostname)}, port: ${port} });
    stream.setTimeout(4000, () => finish('timed out'));
    stream.on('connect', () => { finish('reached'); });
    stream.on('error', (failure) => finish(failure.code));
  });`;

// How long a datagram gets to land, since nothing answers to say it has.
const LANDING_MILLISECONDS = 1_000;

// What reached the witness while the action ran.
async function arrivalsDuring(witness: WebRtcWitness, action: () => Promise<unknown>): Promise<readonly string[]> {
  const already = (await witness.arrivals()).length;
  await action();
  await pause(LANDING_MILLISECONDS);
  return (await witness.arrivals()).slice(already);
}

// The addresses outside the run's network that a page might aim for. Under Docker Desktop this
// machine is reached by an address of its own; on Linux that address is the Docker host's, already here.
const OutsideAddress = {
  BridgeContainer: 'a container on the default bridge',
  HostThroughBridgeGateway: 'the Docker host, through the default bridge\'s gateway',
  WhereRunGatewayWouldBe: 'the first address of the run\'s own network, where a gateway would be',
  Machine: 'the machine running Docker Desktop',
} as const;
type OutsideAddress = (typeof OutsideAddress)[keyof typeof OutsideAddress];

const OUTSIDE_ADDRESSES: readonly OutsideAddress[] = platform() === 'linux'
  ? [OutsideAddress.BridgeContainer, OutsideAddress.HostThroughBridgeGateway, OutsideAddress.WhereRunGatewayWouldBe]
  : Object.values(OutsideAddress);

// A run's network has no gateway, so a peer holds its first address and what is sent there stops at
// that peer. An ordinary container has no route there, so nothing can show the witness hearing at that
// address, and the witness behind it is the one that hears through the default bridge's gateway.
const ADDRESSES_AN_ORDINARY_CONTAINER_REACHES: readonly OutsideAddress[] = OUTSIDE_ADDRESSES.filter((address) => address !== OutsideAddress.WhereRunGatewayWouldBe);

describe('Using the network of a run in the isolated container', () => {
  const outside = new Map<OutsideAddress, WebRtcWitness>();
  let image: string;
  let bridgeWitness: WitnessContainer | undefined;
  let hostWitness: WitnessContainer | undefined;
  let peerWitness: WitnessContainer | undefined;
  let machineRecording: RecordingOrigin | undefined;
  let peer: WebRtcWitness;

  const witnessAt = (address: OutsideAddress): WebRtcWitness => {
    const witness = outside.get(address);
    assert.ok(witness !== undefined, `a witness at ${address}`);
    return witness;
  };

  before(async () => {
    image = await pinnedRunImage();
    bridgeWitness = await startWitnessContainer('bridge');
    hostWitness = await startWitnessContainer(HOST_NETWORK);
    peerWitness = await startWitnessContainer(`${run.handle.runId}-network`);
    peer = peerWitness;
    outside.set(OutsideAddress.BridgeContainer, bridgeWitness);
    outside.set(OutsideAddress.HostThroughBridgeGateway, atAddress(hostWitness, await gatewayOf('bridge')));
    outside.set(OutsideAddress.WhereRunGatewayWouldBe, atAddress(hostWitness, await gatewayOf(`${run.handle.runId}-network`)));
    if (OUTSIDE_ADDRESSES.includes(OutsideAddress.Machine)) {
      machineRecording = await startRecordingOrigin('127.0.0.1');
      outside.set(OutsideAddress.Machine, machineWitness(machineRecording, await machineAddress(image)));
    }
  }, { timeout: TIMEOUT });

  // The witness on the run's network has to go first, or the run could not remove that network.
  after(async () => {
    await peerWitness?.stop();
    await hostWitness?.stop();
    await bridgeWitness?.stop();
    await machineRecording?.close();
  }, { timeout: TIMEOUT });

  for (const channel of WEBRTC_CHANNELS) {
    describe(`given a page that ${channel.attempt}`, () => {
      const attempting = (witness: WebRtcWitness, browser: WebRtcBrowser) => attemptWebRtcInside(run.handle, {
        channelName: channel.name,
        address: { hostname: witness.hostname, port: witness.port, datagramPort: witness.datagramPort },
        browser,
      });

      for (const address of OUTSIDE_ADDRESSES) {
        describe(`and an address on ${address}`, () => {
          describe('when a run opens it through the driver', () => {
            let state: string;
            let arrivals: readonly string[];
            before(async () => {
              const witness = witnessAt(address);
              arrivals = await arrivalsDuring(witness, async () => {
                state = await attempting(witness, WebRtcBrowser.Run);
              });
            }, { timeout: TIMEOUT });

            test('then it should reach nothing there', () => {
              assert.deepEqual(arrivals, []);
            });

            test('then it should finish the plan, so the page did run', () => {
              assert.equal(state, 'Passed');
            });

            test('then it should have every proxy decision about that address blocked', () => {
              const { hostname, port } = witnessAt(address);
              const about = run.handle.proxyDecisions().filter((decision) => decision.origin.includes(`${hostname}:${port}`));
              assert.ok(about.every((decision) => decision.decision === 'blocked'), JSON.stringify(about));
            });
          });

          describe('when a browser with no driver and no proxy opens it', () => {
            test('then it should reach nothing there', { timeout: TIMEOUT }, async () => {
              const witness = witnessAt(address);
              const arrivals = await arrivalsDuring(witness, () => attempting(witness, WebRtcBrowser.Bare));
              assert.deepEqual(arrivals, []);
            });
          });
        });
      }

      describe('and an address on a peer on the run\'s own network', () => {
        describe('when a browser with no driver and no proxy opens it', () => {
          test('then it should arrive, so the silence of the addresses outside means something', { timeout: TIMEOUT }, async () => {
            let state = '';
            const arrivals = await arrivalsDuring(peer, async () => {
              state = await attempting(peer, WebRtcBrowser.Bare);
            });
            assert.equal(state, BARE_BROWSER_STATE);
            assert.ok(arrivals.includes(channel.arrival), JSON.stringify(arrivals));
          });
        });
      });
    });
  }

  for (const address of OUTSIDE_ADDRESSES) {
    describe(`given an address on ${address}`, () => {
      describe('when the run container sends it a datagram and a connection, without a browser', () => {
        test('then it should reach nothing there', { timeout: TIMEOUT }, async (context) => {
          const witness = witnessAt(address);
          const arrivals = await arrivalsDuring(witness, async () => {
            context.diagnostic(JSON.stringify(await jsonInside(run.handle, directDatagramAndConnection(witness))));
          });
          assert.deepEqual(arrivals, []);
        });
      });

      if (ADDRESSES_AN_ORDINARY_CONTAINER_REACHES.includes(address)) {
        describe('when an ordinary container on the default bridge sends the same', () => {
          test('then it should arrive, so the witness can hear', { timeout: TIMEOUT }, async () => {
            const witness = witnessAt(address);
            const arrivals = await arrivalsDuring(witness, () => runDocker([
              'run', '--rm', '--network', 'bridge', '--user', 'node', image, 'node', '-e', directDatagramAndConnection(witness),
            ]));
            assert.ok(arrivals.includes(Arrival.Datagram), JSON.stringify(arrivals));
            assert.ok(arrivals.includes(Arrival.Connection), JSON.stringify(arrivals));
          });
        });
      }
    });
  }
});
