// CONNECT tunnels, as a browser asks for HTTPS and WebSockets, get the same treatment as plain HTTP.
// An allowed one reaches the very address the proxy vetted and carries bytes; a refused one is
// recorded as blocked and dials nothing; a name that rebinds to a private address is refused at its
// next tunnel. Every name resolves through a fake resolver, and every allowed connection goes to a
// local stand-in server, so nothing reaches the network.
import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { after, before, test } from 'node:test';
import { type EgressProxy } from '@revisum/runner';
import { startedEgressProxy } from '#test-support/StartedEgressProxy.ts';
import { connectThroughProxy, startUpstream, UPSTREAM_BODY, type Upstream } from './proxy-requests.ts';
import { egressPolicy, fakeResolver, type FakeResolver } from './runner-examples.ts';

const PUBLIC_ADDRESS = '93.184.215.14';

let upstream: Upstream;
let resolver: FakeResolver;
let proxy: EgressProxy;

before(async () => {
  upstream = await startUpstream();
  resolver = fakeResolver({
    'public.test': [PUBLIC_ADDRESS],
    'carrier.test': [PUBLIC_ADDRESS],
    'private-ten.test': ['10.0.0.5'],
    'metadata.test': ['169.254.169.254'],
    // Public on the first lookup, loopback on every later one: a DNS rebinding attack.
    'rebind.test': [[PUBLIC_ADDRESS], ['127.0.0.1']],
  });
  proxy = await startedEgressProxy({
    policy: egressPolicy({
      allowOrigins: ['https://public.test', 'https://carrier.test', 'https://private-ten.test', 'https://metadata.test', 'https://rebind.test'],
    }),
    resolve: resolver.resolve,
    connect: (address, port) => upstream.connect(address, port),
  });
});
after(async () => {
  await proxy.close();
  await upstream.close();
});

const decisionsFor = (authority: string) => proxy.decisions().filter((entry) => entry.origin === authority);

// Opens a tunnel to `authority` and sends one HTTP request through it, returning what came back.
function requestThroughTunnel(authority: string): Promise<string> {
  const address = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: address.hostname, port: Number(address.port), method: 'CONNECT', path: authority, headers: { host: authority }, timeout: 5000 });
    outgoing.on('connect', (response: IncomingMessage, socket: Socket) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`the tunnel was refused with ${String(response.statusCode)}`)); return; }
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
      socket.write(`GET / HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`);
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error(`no answer for CONNECT ${authority}`)));
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('an allowed CONNECT succeeds, dials the address the proxy vetted, and is recorded as allowed', async () => {
  const dialledBefore = upstream.dialled.length;
  assert.equal(await connectThroughProxy(proxy.url, 'public.test:443'), 200);
  assert.deepEqual(upstream.dialled.slice(dialledBefore), [{ address: PUBLIC_ADDRESS, port: 443 }]);
  assert.deepEqual(decisionsFor('public.test:443'), [{ origin: 'public.test:443', decision: 'allowed' }]);
});

test('an allowed tunnel carries bytes both ways', async () => {
  assert.ok((await requestThroughTunnel('carrier.test:443')).includes(UPSTREAM_BODY));
});

test('a CONNECT to an undeclared origin is recorded as blocked, with no lookup and nothing dialled', async () => {
  const dialledBefore = upstream.dialled.length;
  assert.equal(await connectThroughProxy(proxy.url, 'undeclared.invalid:443'), 403);
  assert.equal(upstream.dialled.length, dialledBefore);
  assert.ok(!resolver.asked.includes('undeclared.invalid'), 'the undeclared name was never looked up');
  assert.deepEqual(decisionsFor('undeclared.invalid:443'), [{ origin: 'undeclared.invalid:443', decision: 'blocked' }]);
});

test('a CONNECT to another port of a declared host is recorded as blocked', async () => {
  const dialledBefore = upstream.dialled.length;
  assert.equal(await connectThroughProxy(proxy.url, 'public.test:8443'), 403);
  assert.equal(upstream.dialled.length, dialledBefore);
  assert.deepEqual(decisionsFor('public.test:8443'), [{ origin: 'public.test:8443', decision: 'blocked' }]);
});

for (const name of ['private-ten.test', 'metadata.test']) {
  test(`a CONNECT to the declared name ${name}, which resolves to a refused address, is recorded as blocked and dials nothing`, async () => {
    const dialledBefore = upstream.dialled.length;
    assert.equal(await connectThroughProxy(proxy.url, `${name}:443`), 403);
    assert.equal(upstream.dialled.length, dialledBefore);
    assert.deepEqual(decisionsFor(`${name}:443`), [{ origin: `${name}:443`, decision: 'blocked' }]);
  });
}

test('a rebinding name is refused for tunnels too: the first tunnel dials the vetted address, the next is refused', async () => {
  const dialledBefore = upstream.dialled.length;
  assert.equal(await connectThroughProxy(proxy.url, 'rebind.test:443'), 200);
  assert.deepEqual(upstream.dialled.slice(dialledBefore), [{ address: PUBLIC_ADDRESS, port: 443 }], 'the counter-example: while public, the name is reached');
  assert.equal(resolver.lookupsOf('rebind.test'), 1, 'one lookup for the tunnel, so the address cannot change in between');

  const dialledThen = upstream.dialled.length;
  assert.equal(await connectThroughProxy(proxy.url, 'rebind.test:443'), 403);
  assert.equal(upstream.dialled.length, dialledThen, 'nothing was dialled once the name pointed at loopback');
  assert.deepEqual(decisionsFor('rebind.test:443').map((entry) => entry.decision), ['allowed', 'blocked']);
});
