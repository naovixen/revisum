// Three more IPv6 ranges are refused whatever they hold: IPv4-translated (::ffff:0:0/96), local
// NAT64 (64:ff9b:1::/48) and Teredo (2001::/32). Each is tried at its edges, and with a public IPv4
// address inside, and the address just outside each edge is allowed, so a check that refused too
// much would fail as surely as one that refused too little. The same forms are also tried through
// the proxy with a fake resolver, so a name resolving to one is refused before anything is dialled.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { checkResolvedAddress, startEgressProxy, type EgressProxy } from '@revisum/runner';
import { connectThroughProxy, getThroughProxy, startUpstream, type Upstream } from './proxy-requests.ts';
import { egressPolicy, fakeResolver } from './runner-examples.ts';

const REFUSED: readonly { readonly range: string; readonly addresses: readonly string[] }[] = [
  {
    range: 'IPv4-translated ::ffff:0:0/96',
    addresses: ['::ffff:0:0.0.0.0', '::ffff:0:127.0.0.1', '::ffff:0:10.0.0.5', '::ffff:0:169.254.169.254', '::ffff:0:8.8.8.8', '::ffff:0:255.255.255.255', '0:0:0:0:ffff:0:808:808'],
  },
  {
    range: 'local NAT64 64:ff9b:1::/48',
    addresses: ['64:ff9b:1::', '64:ff9b:1::1', '64:ff9b:1::127.0.0.1', '64:ff9b:1::8.8.8.8', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '64:FF9B:1::1'],
  },
  {
    range: 'Teredo 2001::/32',
    addresses: ['2001::', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff', '2001:0::8.8.8.8'],
  },
];

// Just outside each range's edges.
const ALLOWED: readonly { readonly range: string; readonly addresses: readonly string[] }[] = [
  { range: 'IPv4-translated ::ffff:0:0/96', addresses: ['::ffff:1:8.8.8.8', '::fffe:0:808:808', '1::ffff:0:808:808'] },
  { range: 'local NAT64 64:ff9b:1::/48', addresses: ['64:ff9b:2::1', '64:ff9b:0:1::1', '64:ff9a:1::1', '64:ff9b::8.8.8.8'] },
  { range: 'Teredo 2001::/32', addresses: ['2001:1::1', '2001:4860:4860::8888', '2000:ffff:ffff:ffff::1', '2002:808:808::1'] },
];

for (const { range, addresses } of REFUSED) {
  test(`an IPv6 address in ${range} is refused, whatever it holds`, { criterion: 'AC-SPEC-07-02' }, () => {
    for (const address of addresses) assert.equal(checkResolvedAddress(address), 'refused', address);
  });
}

for (const { range, addresses } of ALLOWED) {
  test(`counter-example: an IPv6 address just outside ${range} is allowed`, { criterion: 'AC-SPEC-07-02' }, () => {
    for (const address of addresses) assert.equal(checkResolvedAddress(address), 'allowed', address);
  });
}

test('a private service still never reaches a metadata address written in the translated form', { criterion: 'AC-SPEC-07-02' }, () => {
  assert.equal(checkResolvedAddress('::ffff:0:169.254.169.254', { privateService: true }), 'refused');
});

// ---- Through the proxy ------------------------------------------------------------------------------

const NAMES: Readonly<Record<string, readonly string[]>> = {
  'translated.test': ['::ffff:0:8.8.8.8'],
  'local-nat64.test': ['64:ff9b:1::8.8.8.8'],
  'teredo.test': ['2001:0:4136:e378:8000:63bf:3fff:fdd2'],
  'public-ipv6.test': ['2001:4860:4860::8888'],
};

let upstream: Upstream;
let proxy: EgressProxy;

before(async () => {
  upstream = await startUpstream();
  const names = Object.keys(NAMES);
  proxy = await startEgressProxy({
    policy: egressPolicy({ allowOrigins: [...names.map((name) => `http://${name}`), ...names.map((name) => `https://${name}`)] }),
    resolve: fakeResolver(NAMES).resolve,
    connect: (address, port) => upstream.connect(address, port),
  });
});
after(async () => {
  await proxy.close();
  await upstream.close();
});

for (const name of ['translated.test', 'local-nat64.test', 'teredo.test']) {
  test(`the declared name ${name} is refused at resolve time, as a request and as a tunnel`, { criterion: 'AC-SPEC-07-02' }, async () => {
    const dialledBefore = upstream.dialled.length;
    assert.equal((await getThroughProxy(proxy.url, `http://${name}/`)).status, 403);
    assert.equal(await connectThroughProxy(proxy.url, `${name}:443`), 403);
    assert.equal(upstream.dialled.length, dialledBefore);
  });
}

test('counter-example: a declared name with a public IPv6 address is reached through the proxy', { criterion: 'AC-SPEC-07-02' }, async () => {
  assert.equal((await getThroughProxy(proxy.url, 'http://public-ipv6.test/')).status, 200);
  assert.deepEqual(upstream.dialled.at(-1), { address: '2001:4860:4860::8888', port: 80 });
});
