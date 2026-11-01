// A service declared private may resolve to a private address, but never to a cloud metadata
// address, however it is written and whichever way the proxy carries the traffic: a plain-HTTP
// request, a CONNECT tunnel or a TCP relay. A private address on the same proxy, which is reached,
// is the counter-example. Names resolve through a fake resolver and allowed connections go to a
// local stand-in server, so nothing reaches the network.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { createServer as createTcpServer, connect, type AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { DeclaredService } from '@revisum/contracts';
import { checkResolvedAddress, startEgressProxy, type EgressProxy } from '@revisum/runner';
import { connectThroughProxy, getThroughProxy, startUpstream, UPSTREAM_BODY, type Upstream } from './proxy-requests.ts';
import { declaredService, egressPolicy, fakeResolver, origin, serviceName } from './runner-examples.ts';

const PRIVATE_ADDRESS = '10.0.0.7';

// Each way of writing a metadata address that a name could resolve to.
const METADATA_ANSWERS: Readonly<Record<string, readonly string[]>> = {
  'aws-metadata.test': ['169.254.169.254'],
  'alibaba-metadata.test': ['100.100.100.200'],
  'ipv6-metadata.test': ['fd00:ec2::254'],
  'mapped-metadata.test': ['::ffff:169.254.169.254'],
  'compatible-metadata.test': ['::169.254.169.254'],
  'translated-metadata.test': ['::ffff:0:169.254.169.254'],
  'nat64-metadata.test': ['64:ff9b::169.254.169.254'],
  'sixtofour-metadata.test': ['2002:a9fe:a9fe::1'],
  // A private address beside a metadata one: any refused address refuses the name.
  'mixed-metadata.test': [PRIVATE_ADDRESS, '169.254.169.254'],
};
const METADATA_NAMES = Object.keys(METADATA_ANSWERS);
const METADATA_LITERALS = ['http://169.254.169.254', 'http://100.100.100.200', 'http://[fd00:ec2::254]', 'http://[::ffff:169.254.169.254]'];

let upstream: Upstream;
let proxy: EgressProxy;

before(async () => {
  upstream = await startUpstream();
  const services = [
    ...METADATA_NAMES.map((name) => declaredService(name, `http://${name}`, true)),
    ...METADATA_NAMES.map((name) => declaredService(`${name}-tunnel`, `https://${name}`, true)),
    ...METADATA_LITERALS.map((literal, index) => declaredService(`literal-${String.fromCharCode(97 + index)}`, literal, true)),
    declaredService('private-api', 'http://private-api.test', true),
    declaredService('private-tunnel', 'https://private-api.test', true),
  ];
  proxy = await startEgressProxy({
    policy: egressPolicy({ allowServices: services.map((service) => service.name) }),
    services,
    resolve: fakeResolver({ ...METADATA_ANSWERS, 'private-api.test': [PRIVATE_ADDRESS] }).resolve,
    connect: (address, port) => upstream.connect(address, port),
  });
});
after(async () => {
  await proxy.close();
  await upstream.close();
});

for (const name of METADATA_NAMES) {
  test(`a private service whose name resolves as ${name} does gets 403 over HTTP and dials nothing`, { criterion: 'AC-SPEC-07-02' }, async () => {
    const dialledBefore = upstream.dialled.length;
    const answer = await getThroughProxy(proxy.url, `http://${name}/latest/meta-data/`);
    assert.equal(answer.status, 403);
    assert.equal(upstream.dialled.length, dialledBefore, JSON.stringify(upstream.dialled.slice(dialledBefore)));
    assert.ok(proxy.decisions().some((entry) => entry.origin === `http://${name}` && entry.decision === 'blocked'), JSON.stringify(proxy.decisions()));
  });

  test(`a private service whose name resolves as ${name} does is refused a tunnel and dials nothing`, { criterion: 'AC-SPEC-07-02' }, async () => {
    const dialledBefore = upstream.dialled.length;
    assert.equal(await connectThroughProxy(proxy.url, `${name}:443`), 403);
    assert.equal(upstream.dialled.length, dialledBefore, JSON.stringify(upstream.dialled.slice(dialledBefore)));
  });
}

for (const literal of METADATA_LITERALS) {
  test(`a private service declared with the metadata literal ${literal} gets 403 and dials nothing`, { criterion: 'AC-SPEC-07-02' }, async () => {
    const dialledBefore = upstream.dialled.length;
    const answer = await getThroughProxy(proxy.url, `${literal}/latest/meta-data/`);
    assert.equal(answer.status, 403);
    assert.equal(upstream.dialled.length, dialledBefore, JSON.stringify(upstream.dialled.slice(dialledBefore)));
  });
}

test('counter-example: on the same proxy, a private service at a private address is reached over HTTP and by tunnel', { criterion: 'AC-SPEC-07-02' }, async () => {
  const answer = await getThroughProxy(proxy.url, 'http://private-api.test/orders');
  assert.equal(answer.status, 200);
  assert.equal(answer.body, UPSTREAM_BODY);
  assert.deepEqual(upstream.dialled.at(-1), { address: PRIVATE_ADDRESS, port: 80 });
  assert.equal(await connectThroughProxy(proxy.url, 'private-api.test:443'), 200);
  assert.deepEqual(upstream.dialled.at(-1), { address: PRIVATE_ADDRESS, port: 443 });
});

test('the address check itself refuses every metadata form for a private service, and allows a private address', { criterion: 'AC-SPEC-07-02' }, () => {
  for (const address of Object.values(METADATA_ANSWERS).flat().filter((answer) => answer !== PRIVATE_ADDRESS)) {
    assert.equal(checkResolvedAddress(address, { privateService: true }), 'refused', address);
  }
  assert.equal(checkResolvedAddress(PRIVATE_ADDRESS, { privateService: true }), 'allowed');
});

// ---- A TCP relay -------------------------------------------------------------------------------------

// A port nothing is listening on now, for a relay to listen on.
async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Connects to a relay and resolves once the proxy has closed the connection.
function untilClosed(port: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('close', () => resolve());
    socket.on('error', () => socket.destroy());
    socket.resume();
  });
}

test('a TCP relay to a private service that resolves to a metadata address closes the connection and dials nothing', { criterion: 'AC-SPEC-07-02' }, async () => {
  const port = await freePort();
  const service: DeclaredService = { name: serviceName('metadata-database'), origin: origin('http://metadata-database.test'), private: true, port };
  const relayUpstream = await startUpstream();
  const relayProxy = await startEgressProxy({
    policy: { ...egressPolicy({ allowServices: [] }), allowTcpServices: [service.name] },
    services: [service],
    resolve: fakeResolver({ 'metadata-database.test': ['169.254.169.254'] }).resolve,
    connect: (address, dialledPort) => relayUpstream.connect(address, dialledPort),
  });
  try {
    await untilClosed(port);
    assert.deepEqual(relayUpstream.dialled, []);
    assert.deepEqual(relayProxy.decisions(), [{ origin: `metadata-database.test:${port}`, decision: 'blocked' }]);
  } finally {
    await relayProxy.close();
    await relayUpstream.close();
  }
});
