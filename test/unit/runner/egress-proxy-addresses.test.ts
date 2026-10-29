// The egress proxy's resolve-time check, end to end in-process. Every origin below is on the
// policy's allow-list, so only the address check can refuse it. The proxy resolves each name
// itself, through a fake resolver that never touches the network, refuses the request when any
// address is refused, and otherwise connects to the very address it vetted, with no second
// lookup. The proxy's connect function is the test's own: it records the vetted address and
// connects to a local stand-in server, so allowed requests never leave the machine either.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startEgressProxy, type EgressProxy } from '@revisum/runner';
import { connectThroughProxy, getThroughProxy, startUpstream, UPSTREAM_BODY, type Upstream } from './proxy-requests.ts';
import { declaredService, egressPolicy, fakeResolver, origin, type FakeResolver } from './runner-examples.ts';

const PUBLIC_ADDRESS = '93.184.215.14';

// Names, and what the fake resolver answers for each.
const NAMES: Readonly<Record<string, readonly string[] | readonly (readonly string[])[]>> = {
  'loopback.test': ['127.0.0.1'],
  '127.0.0.1.nip.io': ['127.0.0.1'],
  'localhost': ['127.0.0.1', '::1'],
  'private-ten.test': ['10.0.0.5'],
  'private-home.test': ['192.168.1.1'],
  'shared-space.test': ['100.64.0.1'],
  'link-local.test': ['169.254.10.20'],
  'metadata.test': ['169.254.169.254'],
  'alibaba-metadata.test': ['100.100.100.200'],
  'ipv6-metadata.test': ['fd00:ec2::254'],
  'ipv6-loopback.test': ['::1'],
  'unique-local.test': ['fd12:3456::1'],
  'mapped.test': ['::ffff:127.0.0.1'],
  'nat64.test': ['64:ff9b::169.254.169.254'],
  'six-to-four.test': ['2002:a9fe:a9fe::1'],
  'zero.test': ['0.0.0.0'],
  // One public and one private address: any refused address refuses the name.
  'mixed.test': [PUBLIC_ADDRESS, '10.0.0.5'],
  'public.test': [PUBLIC_ADDRESS],
  'public-ipv6.test': ['2606:4700::1111'],
  'public-mapped.test': ['::ffff:8.8.8.8'],
  // A service declared private may resolve to a private address; one not declared private may not.
  'private-api.test': ['10.0.0.7'],
  'internal-api.test': ['10.0.0.8'],
  // Public on the first lookup, loopback on every later one: a DNS rebinding attack.
  'rebind.test': [[PUBLIC_ADDRESS], ['127.0.0.1']],
};

const REFUSED_NAMES = [
  'loopback.test', '127.0.0.1.nip.io', 'localhost', 'private-ten.test', 'private-home.test', 'shared-space.test', 'link-local.test',
  'metadata.test', 'alibaba-metadata.test', 'ipv6-metadata.test', 'ipv6-loopback.test', 'unique-local.test', 'mapped.test',
  'nat64.test', 'six-to-four.test', 'zero.test', 'mixed.test',
];

// IP literals, as written in a URL. The URL parser turns the unusual IPv4 forms into 127.0.0.1.
const REFUSED_LITERALS = [
  'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data/', 'http://100.100.100.200/', 'http://[::1]/',
  'http://[fd00:ec2::254]/', 'http://[::ffff:127.0.0.1]/', 'http://0x7f000001/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://127.1/',
];

const ALLOWED_TARGETS: readonly { readonly target: string; readonly address: string; readonly sameAddress?: string }[] = [
  { target: 'http://public.test/', address: PUBLIC_ADDRESS },
  { target: 'http://public-ipv6.test/', address: '2606:4700::1111' },
  { target: 'http://public-mapped.test/', address: '::ffff:8.8.8.8', sameAddress: '8.8.8.8' },
  { target: 'http://8.8.8.8/', address: '8.8.8.8' },
];

let upstream: Upstream;
let resolver: FakeResolver;
let proxy: EgressProxy;

before(async () => {
  upstream = await startUpstream();
  resolver = fakeResolver(NAMES);
  const literalOrigins = REFUSED_LITERALS.map((literal) => new URL(literal).origin);
  const nameOrigins = Object.keys(NAMES).filter((name) => !name.endsWith('-api.test')).map((name) => `http://${name}`);
  proxy = await startEgressProxy({
    policy: egressPolicy({ allowOrigins: [...new Set([...nameOrigins, ...literalOrigins, 'http://8.8.8.8'])], allowServices: ['private-api', 'internal-api'] }),
    services: [declaredService('private-api', 'http://private-api.test', true), declaredService('internal-api', 'http://internal-api.test', false)],
    resolve: resolver.resolve,
    connect: (address, port) => upstream.connect(address, port),
  });
});
after(async () => {
  await proxy.close();
  await upstream.close();
});

const dialledHosts = (): readonly string[] => upstream.dialled.map((dialled) => dialled.address);
const blockedOrigins = (): readonly string[] => proxy.decisions().filter((entry) => entry.decision === 'blocked').map((entry) => String(entry.origin));

describe('a declared origin whose name resolves to a refused address is refused at resolve time', () => {
  for (const name of REFUSED_NAMES) {
    test(`http://${name} gets 403, is recorded as blocked, and no connection is made`, { criterion: 'AC-SPEC-07-02' }, async () => {
      const dialledBefore = upstream.dialled.length;
      const answer = await getThroughProxy(proxy.url, `http://${name}/`);
      assert.equal(answer.status, 403);
      assert.notEqual(answer.body, UPSTREAM_BODY);
      assert.equal(upstream.dialled.length, dialledBefore, `the proxy connected to ${JSON.stringify(upstream.dialled.slice(dialledBefore))}`);
      assert.ok(resolver.lookupsOf(name) >= 1, 'the proxy resolved the name itself');
      assert.ok(blockedOrigins().includes(origin(`http://${name}`)), JSON.stringify(proxy.decisions()));
    });
  }
});

describe('a declared origin written as a refused IP literal is refused', () => {
  for (const literal of REFUSED_LITERALS) {
    test(`${literal} gets 403 and no connection is made`, { criterion: 'AC-SPEC-07-02' }, async () => {
      const dialledBefore = upstream.dialled.length;
      const answer = await getThroughProxy(proxy.url, literal);
      assert.equal(answer.status, 403);
      assert.equal(upstream.dialled.length, dialledBefore);
      assert.ok(blockedOrigins().includes(new URL(literal).origin), JSON.stringify(proxy.decisions()));
    });
  }
});

test('a tunnel to a name that resolves to a private address is refused, as HTTPS would ask for it', { criterion: 'AC-SPEC-07-02' }, async () => {
  const dialledBefore = upstream.dialled.length;
  const status = await connectThroughProxy(proxy.url, 'private-ten.test:443');
  assert.notEqual(status, 200);
  assert.equal(upstream.dialled.length, dialledBefore);
});

test('a tunnel to the cloud metadata address, written as an IPv6 literal, is refused', { criterion: 'AC-SPEC-07-02' }, async () => {
  const dialledBefore = upstream.dialled.length;
  const status = await connectThroughProxy(proxy.url, '[fd00:ec2::254]:443');
  assert.notEqual(status, 200);
  assert.equal(upstream.dialled.length, dialledBefore);
});

describe('counter-examples: public addresses on the same proxy are allowed', () => {
  for (const { target, address, sameAddress } of ALLOWED_TARGETS) {
    test(`${target} reaches the upstream server through the address the proxy vetted`, { criterion: 'AC-SPEC-07-02' }, async () => {
      const answer = await getThroughProxy(proxy.url, target);
      assert.equal(answer.status, 200);
      assert.equal(answer.body, UPSTREAM_BODY);
      // An IPv4-mapped address may be dialled in either of its two forms.
      const dialled = dialledHosts().at(-1);
      assert.ok(dialled !== undefined && [address, sameAddress].includes(dialled), JSON.stringify(dialled));
    });
  }

  test('a service declared private may resolve to a private address', { criterion: 'AC-SPEC-07-02' }, async () => {
    const answer = await getThroughProxy(proxy.url, 'http://private-api.test/orders');
    assert.equal(answer.status, 200);
    assert.equal(dialledHosts().at(-1), '10.0.0.7');
  });
});

test('a declared service that is not declared private is refused when it resolves to a private address', { criterion: 'AC-SPEC-07-02' }, async () => {
  const dialledBefore = upstream.dialled.length;
  const answer = await getThroughProxy(proxy.url, 'http://internal-api.test/orders');
  assert.equal(answer.status, 403);
  assert.equal(upstream.dialled.length, dialledBefore);
});

test('a rebinding name is looked up once and the proxy connects to the address it vetted, never the later private one', { criterion: 'AC-SPEC-07-02' }, async () => {
  const lookupsBefore = resolver.lookupsOf('rebind.test');
  const answer = await getThroughProxy(proxy.url, 'http://rebind.test/');
  assert.equal(answer.status, 200);
  assert.equal(resolver.lookupsOf('rebind.test') - lookupsBefore, 1, 'exactly one lookup for the request');
  assert.deepEqual(upstream.dialled.at(-1), { address: PUBLIC_ADDRESS, port: 80 });
  assert.equal(upstream.hosts.at(-1), 'rebind.test', 'the request still names the host it was sent to');
});

test('a second request to the rebinding name, now resolving to loopback, is refused', { criterion: 'AC-SPEC-07-02' }, async () => {
  const dialledBefore = upstream.dialled.length;
  const answer = await getThroughProxy(proxy.url, 'http://rebind.test/');
  assert.equal(answer.status, 403);
  assert.equal(upstream.dialled.length, dialledBefore);
});

test('an undeclared origin is refused before its name is resolved, so the lookup never leaves the proxy', { criterion: 'AC-SPEC-07-01' }, async () => {
  const answer = await getThroughProxy(proxy.url, 'http://undeclared.invalid/');
  assert.equal(answer.status, 403);
  assert.ok(!resolver.asked.includes('undeclared.invalid'), `the proxy looked up ${JSON.stringify(resolver.asked)}`);
  assert.ok(blockedOrigins().includes('http://undeclared.invalid'));
});
