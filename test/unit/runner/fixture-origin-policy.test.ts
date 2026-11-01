// A browser mutant rewrites plain-HTTP responses from declared origins only, so neither the policy
// builder nor the proxy may accept anything wider. The builder alone knows which origins are
// fixtures, and refuses one that is undeclared or not plain HTTP. EgressPolicy stays unbranded, so
// a policy can be built by hand; the proxy therefore refuses to start with such a rewrite too, both
// through startEgressProxy and through startProxyServer, which is how the proxy's container starts it
// from the rules in its environment. A declared plain-HTTP origin, accepted and rewritten, is the
// counter-example.
// What these tests assume about shapes the spec leaves open: each refusal from the builder names
// the origin it refused, and the proxy refuses by rejecting, as it does when it cannot listen.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EgressPolicy, FixtureRewrite, Origin } from '@revisum/contracts';
import {
  buildEgressPolicy, proxyRules, readProxyRules, startEgressProxy, startProxyServer, type EgressProxy, type ProxyRules, type ResponseRewrite,
} from '@revisum/runner';
import { getThroughProxy, startUpstream, UPSTREAM_BODY } from './proxy-requests.ts';
import { fakeResolver, origin } from './runner-examples.ts';

const PLAIN = origin('http://fixture.test');
const SECURE = origin('https://fixture.test');
const SOCKET = origin('ws://fixture.test');
const UNDECLARED = origin('http://undeclared.test');
const REWRITE: ResponseRewrite = { name: 'body-changed', find: 'reached', replace: 'rewritten' };
const rewriteOn = (fixture: Origin): FixtureRewrite => ({ origin: fixture, rewrite: REWRITE });

// ---- The policy builder --------------------------------------------------------------------------

const REFUSED_FIXTURES: readonly { readonly title: string; readonly allowOrigins: readonly Origin[]; readonly fixture: Origin }[] = [
  { title: 'a fixture origin the policy does not declare', allowOrigins: [PLAIN], fixture: UNDECLARED },
  { title: 'a declared HTTPS fixture origin', allowOrigins: [SECURE], fixture: SECURE },
  { title: 'a declared WebSocket fixture origin', allowOrigins: [SOCKET], fixture: SOCKET },
];

for (const { title, allowOrigins, fixture } of REFUSED_FIXTURES) {
  test(`the builder refuses ${title}, with no rewrite on it yet`, { criterion: 'AC-SPEC-07-07' }, () => {
    const built = buildEgressPolicy({ allowOrigins, allowServices: [], fixtureOrigins: [fixture] });
    assert.ok(!built.ok, JSON.stringify(built));
    assert.equal(built.error.origin, fixture);
  });

  test(`the builder refuses ${title}, with a rewrite on it`, { criterion: 'AC-SPEC-07-07' }, () => {
    const built = buildEgressPolicy({ allowOrigins, allowServices: [], fixtureOrigins: [fixture], responseRewrites: [rewriteOn(fixture)] });
    assert.ok(!built.ok, JSON.stringify(built));
    assert.equal(built.error.origin, fixture);
  });
}

test('one refused fixture origin refuses the policy, even beside an accepted one', { criterion: 'AC-SPEC-07-07' }, () => {
  const built = buildEgressPolicy({ allowOrigins: [PLAIN, SECURE], allowServices: [], fixtureOrigins: [PLAIN, SECURE] });
  assert.ok(!built.ok, JSON.stringify(built));
  assert.equal(built.error.origin, SECURE);
});

test('counter-example: the builder accepts a declared plain-HTTP fixture origin and its rewrite', { criterion: 'AC-SPEC-07-07' }, () => {
  const built = buildEgressPolicy({ allowOrigins: [PLAIN], allowServices: [], fixtureOrigins: [PLAIN], responseRewrites: [rewriteOn(PLAIN)] });
  assert.ok(built.ok, JSON.stringify(built));
  assert.deepEqual(built.value.responseRewrites, [rewriteOn(PLAIN)]);
});

// ---- The proxy, given a policy built by hand ---------------------------------------------------------

const handBuilt = (allowOrigins: readonly Origin[], rewrites: readonly FixtureRewrite[]): EgressPolicy =>
  ({ allowOrigins, allowServices: [], allowTcpServices: [], denyPrivateRanges: true, responseRewrites: rewrites });

// True when the proxy refused to start. One that did start is closed again, so a proxy that should
// have refused fails its test rather than keeping the test process alive.
async function refusesToStart(start: () => Promise<EgressProxy>): Promise<boolean> {
  try {
    const proxy = await start();
    await proxy.close();
    return false;
  } catch {
    return true;
  }
}

// The rules exactly as the proxy's container reads them: the policy's rules, through the text of its
// environment variable.
function rulesInContainer(policy: EgressPolicy): ProxyRules {
  const rules = readProxyRules(JSON.stringify(proxyRules(policy)));
  assert.ok(rules !== null, 'the rules survive being written to the container\'s environment');
  return rules;
}

const REFUSED_POLICIES: readonly { readonly title: string; readonly policy: EgressPolicy }[] = [
  { title: 'a hand-built rewrite on an undeclared origin', policy: handBuilt([PLAIN], [rewriteOn(UNDECLARED)]) },
  { title: 'a hand-built rewrite on an HTTPS origin, even a declared one', policy: handBuilt([SECURE], [rewriteOn(SECURE)]) },
  { title: 'a hand-built rewrite on a WebSocket origin, even a declared one', policy: handBuilt([SOCKET], [rewriteOn(SOCKET)]) },
  { title: 'one refused rewrite beside an accepted one', policy: handBuilt([PLAIN], [rewriteOn(PLAIN), rewriteOn(UNDECLARED)]) },
];

for (const { title, policy } of REFUSED_POLICIES) {
  test(`startEgressProxy refuses to start with ${title}`, { criterion: 'AC-SPEC-07-07' }, async () => {
    assert.equal(await refusesToStart(() => startEgressProxy({ policy, resolve: fakeResolver({}).resolve })), true);
  });

  test(`startProxyServer, as the proxy's container calls it, refuses to start with ${title}`, { criterion: 'AC-SPEC-07-07' }, async () => {
    assert.equal(await refusesToStart(() => startProxyServer(rulesInContainer(policy), { resolve: fakeResolver({}).resolve })), true);
  });
}

test('counter-example: startProxyServer, as the proxy\'s container calls it, starts with a rewrite on a declared plain-HTTP origin, and applies it', { criterion: 'AC-SPEC-07-07' }, async () => {
  const upstream = await startUpstream();
  const proxy = await startProxyServer(rulesInContainer(handBuilt([PLAIN], [rewriteOn(PLAIN)])), {
    resolve: fakeResolver({ 'fixture.test': ['93.184.215.14'] }).resolve,
    connect: (address, port) => upstream.connect(address, port),
  });
  try {
    const answer = await getThroughProxy(proxy.url, 'http://fixture.test/');
    assert.equal(answer.body, UPSTREAM_BODY.replace('reached', 'rewritten'));
    assert.deepEqual(proxy.rewritesApplied(), [{ origin: PLAIN, name: REWRITE.name }]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('counter-example: the proxy starts with a hand-built rewrite on a declared plain-HTTP origin, and applies it', { criterion: 'AC-SPEC-07-07' }, async () => {
  const upstream = await startUpstream();
  const proxy = await startEgressProxy({
    policy: handBuilt([PLAIN], [rewriteOn(PLAIN)]),
    resolve: fakeResolver({ 'fixture.test': ['93.184.215.14'] }).resolve,
    connect: (address, port) => upstream.connect(address, port),
  });
  try {
    const answer = await getThroughProxy(proxy.url, 'http://fixture.test/');
    assert.equal(answer.body, UPSTREAM_BODY.replace('reached', 'rewritten'));
    assert.deepEqual(proxy.rewritesApplied(), [{ origin: PLAIN, name: REWRITE.name }]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
