// A malformed request the proxy refuses with 400 is still a request that tried to leave the run, so
// it is recorded as a blocked decision. The decision must also survive the trip from the proxy's
// file: the reader of those lines drops an entry with no origin, so an empty origin would lose it.
// A well-formed request, which adds its own one decision, is the counter-example.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readProxyDecision, startEgressProxy, type EgressProxy } from '@revisum/runner';
import { connectThroughProxy, getThroughProxy, startUpstream, type Upstream } from './proxy-requests.ts';
import { egressPolicy, fakeResolver } from './runner-examples.ts';

let upstream: Upstream;
let proxy: EgressProxy;

before(async () => {
  upstream = await startUpstream();
  proxy = await startEgressProxy({
    policy: egressPolicy({ allowOrigins: ['http://public.test'] }),
    resolve: fakeResolver({ 'public.test': ['93.184.215.14'] }).resolve,
    connect: (address, port) => upstream.connect(address, port),
  });
});
after(async () => {
  await proxy.close();
  await upstream.close();
});

const MALFORMED: readonly { readonly title: string; readonly send: () => Promise<number> }[] = [
  { title: 'a plain request with no absolute URL', send: async () => (await getThroughProxy(proxy.url, '/not-absolute')).status },
  { title: 'a plain request with a scheme the proxy does not forward', send: async () => (await getThroughProxy(proxy.url, 'ftp://files.test/report')).status },
  { title: 'an HTTPS URL sent as a plain request instead of a tunnel', send: async () => (await getThroughProxy(proxy.url, 'https://public.test/')).status },
  { title: 'a tunnel to a port beyond the last one', send: () => connectThroughProxy(proxy.url, 'public.test:70000') },
  { title: 'a tunnel to port zero', send: () => connectThroughProxy(proxy.url, 'public.test:0') },
];

for (const { title, send } of MALFORMED) {
  test(`${title} gets 400, is recorded as blocked, and dials nothing`, async () => {
    const decisionsBefore = proxy.decisions().length;
    const dialledBefore = upstream.dialled.length;
    assert.equal(await send(), 400);
    const added = proxy.decisions().slice(decisionsBefore);
    assert.equal(added.length, 1, JSON.stringify(added));
    assert.equal(added[0]?.decision, 'blocked');
    assert.equal(upstream.dialled.length, dialledBefore);
    assert.deepEqual(readProxyDecision(JSON.stringify(added[0])), added[0], 'the decision survives being read back from the proxy\'s file');
  });
}

test('counter-example: a well-formed request to a declared origin is recorded as allowed, not blocked', async () => {
  const decisionsBefore = proxy.decisions().length;
  assert.equal((await getThroughProxy(proxy.url, 'http://public.test/')).status, 200);
  assert.deepEqual(proxy.decisions().slice(decisionsBefore), [{ origin: 'http://public.test', decision: 'allowed' }]);
});
