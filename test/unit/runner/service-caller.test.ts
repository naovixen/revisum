// Runner's real service caller, against a local node:http service through the in-process egress
// proxy. The caller sends each declared call's request through the proxy, so the proxy's allow-list
// and resolve-time address check apply, and a refusal there is egress-blocked. It returns a
// redirect as received, never following it; it stops reading at the request's size cap; it sends a
// write once, never again, even after a timeout; and it writes no header value anywhere but the
// wire. How the engine judges what the caller returns is tested with a fake caller in
// test/unit/engine/service-call-runs.test.ts; the same runs with this caller are in
// service-caller-runs.test.ts.
// See docs/specs/SPEC-32-declared-service-calls.md, "The real caller".
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';
import { failure } from '@revisum/contracts';
import { echoesIn, fakeSecretValue, resolvedSecret } from '../engine/secret-examples.ts';
import {
  OK_BODY, ORDER_PATH, bodyAsText, closedPort, consoleWrittenDuring, droppedAnswer, emptyAnswer, endlessAnswer, jsonAnswer,
  serviceRequest, settle, silentAnswer, sizedAnswer, textAnswer, unfinishedAnswer, withCallerHarness, type Answer, type ReceivedRequest,
} from './local-service.ts';
import { declaredService, origin } from './runner-examples.ts';

const PUBLIC_ADDRESS = '93.184.215.14';
const paths = (received: readonly ReceivedRequest[]): string[] => received.map((request) => `${request.method} ${request.path}`);

// ---- The proxy decides where a call may go ---------------------------------------------------------

// Declared services whose names resolve to addresses the proxy refuses. None is declared private.
const REFUSED_SERVICES: readonly { readonly name: string; readonly address: string }[] = [
  { name: 'loopback-shop', address: '127.0.0.1' },
  { name: 'ipv6-loopback-shop', address: '::1' },
  { name: 'private-shop', address: '10.0.0.5' },
  { name: 'home-shop', address: '192.168.1.20' },
  { name: 'link-local-shop', address: '169.254.10.20' },
  { name: 'metadata-shop', address: '169.254.169.254' },
  { name: 'ipv6-metadata-shop', address: 'fd00:ec2::254' },
];

describe('a service that resolves to a refused address and is not declared private', () => {
  for (const refused of REFUSED_SERVICES) {
    test(`${refused.name}, resolving to ${refused.address}, fails with egress-blocked and is never reached`, { criterion: 'AC-SPEC-32-05' }, async () => {
      const target = `http://${refused.name}.test`;
      await withCallerHarness({
        names: { [`${refused.name}.test`]: [refused.address] },
        services: [declaredService(refused.name, target, false)],
      }, async ({ caller, service, proxy, resolver }) => {
        const answered = await caller.call(serviceRequest(target));
        assert.deepEqual(answered, failure('egress-blocked'));
        assert.deepEqual(service.received, [], 'the service received the request');
        assert.deepEqual(service.dialled, [], 'the proxy connected');
        assert.ok(resolver.lookupsOf(`${refused.name}.test`) >= 1, 'the proxy did not resolve the name, so the request never went through it');
        assert.ok(proxy.decisions().some((decision) => decision.origin === origin(target) && decision.decision === 'blocked'), JSON.stringify(proxy.decisions()));
      });
    });
  }
});

// Counter-example: the same kind of name, resolving to a public address, is reached.
test('a service that resolves to a public address is reached through the address the proxy vetted', { criterion: 'AC-SPEC-32-05' }, async () => {
  const target = 'http://public-shop.test';
  await withCallerHarness({
    names: { 'public-shop.test': [PUBLIC_ADDRESS] },
    services: [declaredService('public-shop', target, false)],
  }, async ({ caller, service, proxy }) => {
    const answered = await caller.call(serviceRequest(target));
    assert.ok(answered.ok, JSON.stringify(answered));
    assert.equal(answered.value.status, 200);
    assert.deepEqual(JSON.parse(bodyAsText(answered.value.body)), OK_BODY);
    assert.deepEqual(paths(service.received), [`GET ${ORDER_PATH}`]);
    assert.deepEqual(service.dialled, [{ address: PUBLIC_ADDRESS, port: 80 }], 'the proxy connected to the address it vetted');
    assert.equal(service.received[0]?.headers.host, 'public-shop.test', 'the request names the service it was sent to');
    assert.ok(proxy.decisions().some((decision) => decision.origin === origin(target) && decision.decision === 'allowed'), JSON.stringify(proxy.decisions()));
  });
});

// The caller must not go round the proxy: here the service really listens on loopback, so a caller
// that connected directly would reach it.
test('a listening loopback service that is not declared private fails with egress-blocked and receives nothing', { criterion: 'AC-SPEC-32-05' }, async () => {
  await withCallerHarness({ localServicePrivate: false, realConnections: true }, async ({ caller, service, proxy }) => {
    const answered = await caller.call(serviceRequest(service.origin));
    assert.deepEqual(answered, failure('egress-blocked'));
    assert.deepEqual(service.received, [], 'the caller reached the service without the proxy');
    assert.ok(proxy.decisions().some((decision) => decision.decision === 'blocked'), JSON.stringify(proxy.decisions()));
  });
});

// Counter-example: the same service, declared private, is reached through the proxy.
test('the same loopback service, declared private, is reached through the proxy', { criterion: 'AC-SPEC-32-05' }, async () => {
  await withCallerHarness({ localServicePrivate: true, realConnections: true }, async ({ caller, service, proxy }) => {
    const answered = await caller.call(serviceRequest(service.origin));
    assert.ok(answered.ok, JSON.stringify(answered));
    assert.equal(answered.value.status, 200);
    assert.deepEqual(paths(service.received), [`GET ${ORDER_PATH}`]);
    assert.deepEqual(proxy.decisions(), [{ origin: origin(service.origin), decision: 'allowed' }]);
  });
});

test('a service the policy does not allow fails with egress-blocked, and the proxy never looks its name up', { criterion: 'AC-SPEC-32-05' }, async () => {
  await withCallerHarness({ names: { 'undeclared-shop.test': [PUBLIC_ADDRESS] } }, async ({ caller, service, resolver }) => {
    const answered = await caller.call(serviceRequest('http://undeclared-shop.test'));
    assert.deepEqual(answered, failure('egress-blocked'));
    assert.deepEqual(service.received, []);
    assert.ok(!resolver.asked.includes('undeclared-shop.test'), JSON.stringify(resolver.asked));
  });
});

// Counter-example: a 403 the service itself sends is a status like any other, for the engine to judge.
test('a 403 the service itself sends is returned as its status, not as egress-blocked', { criterion: 'AC-SPEC-32-05' }, async () => {
  await withCallerHarness({ answer: jsonAnswer(403, { error: 'forbidden' }) }, async ({ caller, service }) => {
    const answered = await caller.call(serviceRequest(service.origin));
    assert.ok(answered.ok, JSON.stringify(answered));
    assert.equal(answered.value.status, 403);
    assert.deepEqual(JSON.parse(bodyAsText(answered.value.body)), { error: 'forbidden' });
  });
});

// ---- Redirects are returned, never followed --------------------------------------------------------

// A caller that followed redirects could loop on these, so each test gives up rather than hang.
const REDIRECT_TEST_TIMEOUT = 20_000;

for (const status of [301, 302, 303, 307, 308]) {
  test(`a ${status} redirect is returned as received, and its location is never requested`, { criterion: 'AC-SPEC-32-05', timeout: REDIRECT_TEST_TIMEOUT }, async () => {
    await withCallerHarness({}, async ({ caller, service }) => {
      // The location is on the same declared service, so a caller that followed it would get there.
      service.answerWith((received, response) => {
        if (received.path === '/api/test/reset') response.writeHead(status, { location: `${service.origin}/api/test/landing` }).end();
        else response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
      const answered = await caller.call(serviceRequest(service.origin, { method: 'POST', pathAndQuery: '/api/test/reset', body: ['{}'] }));
      assert.ok(answered.ok, JSON.stringify(answered));
      assert.equal(answered.value.status, status);
      assert.deepEqual(paths(service.received), ['POST /api/test/reset'], 'the redirect was followed or the request repeated');
    });
  });
}

test('a redirect to another declared service is not followed: the proxy is never asked for it', { criterion: 'AC-SPEC-32-05', timeout: REDIRECT_TEST_TIMEOUT }, async () => {
  const elsewhere = 'http://elsewhere-shop.test';
  await withCallerHarness({
    answer: emptyAnswer(302, { location: `${elsewhere}/landing` }),
    names: { 'elsewhere-shop.test': [PUBLIC_ADDRESS] },
    services: [declaredService('elsewhere-shop', elsewhere, false)],
  }, async ({ caller, service, proxy, resolver }) => {
    const answered = await caller.call(serviceRequest(service.origin));
    assert.ok(answered.ok, JSON.stringify(answered));
    assert.equal(answered.value.status, 302);
    assert.deepEqual(paths(service.received), [`GET ${ORDER_PATH}`]);
    assert.ok(!proxy.decisions().some((decision) => decision.origin === origin(elsewhere)), JSON.stringify(proxy.decisions()));
    assert.ok(!resolver.asked.includes('elsewhere-shop.test'));
  });
});

// ---- Statuses, timeouts and connections ------------------------------------------------------------

test('a 500 is returned as received, status and body, for the engine to judge', { criterion: 'AC-SPEC-32-07' }, async () => {
  await withCallerHarness({ answer: jsonAnswer(500, { error: 'database down' }) }, async ({ caller, service }) => {
    const answered = await caller.call(serviceRequest(service.origin));
    assert.ok(answered.ok, JSON.stringify(answered));
    assert.equal(answered.value.status, 500);
    assert.equal(bodyAsText(answered.value.body), JSON.stringify({ error: 'database down' }));
  });
});

const TIMEOUT = 400;

for (const [name, answer] of [['never answers', silentAnswer], ['sends its headers but never finishes the body', unfinishedAnswer]] as const) {
  test(`a service that ${name} fails with call-timeout once the request's timeout runs out`, { criterion: 'AC-SPEC-32-07' }, async () => {
    await withCallerHarness({ answer }, async ({ caller, service }) => {
      const started = performance.now();
      const answered = await caller.call(serviceRequest(service.origin, { timeoutMilliseconds: TIMEOUT }));
      const waited = performance.now() - started;
      assert.deepEqual(answered, failure('call-timeout'));
      assert.ok(waited >= TIMEOUT * 0.9, `the caller gave up after ${Math.round(waited)} ms`);
      assert.ok(waited < TIMEOUT + 3000, `the caller waited ${Math.round(waited)} ms`);
    });
  });
}

test('a service nothing listens for fails with service-unreachable', { criterion: 'AC-SPEC-32-07' }, async () => {
  const port = await closedPort();
  const target = `http://127.0.0.1:${port}`;
  await withCallerHarness({ realConnections: true, services: [declaredService('stopped-shop', target, true)] }, async ({ caller }) => {
    assert.deepEqual(await caller.call(serviceRequest(target)), failure('service-unreachable'));
  });
});

// Counter-example: a 502 the service itself sends is a status, not an unreachable service.
test('a 502 the service itself sends is returned as its status, not as service-unreachable', { criterion: 'AC-SPEC-32-07' }, async () => {
  await withCallerHarness({ answer: textAnswer(502, 'text/plain', 'bad gateway upstream') }, async ({ caller, service }) => {
    const answered = await caller.call(serviceRequest(service.origin));
    assert.ok(answered.ok, JSON.stringify(answered));
    assert.equal(answered.value.status, 502);
  });
});

test('when the proxy is not listening, the call fails with service-unreachable and never goes to the service directly', { criterion: 'AC-SPEC-32-07' }, async () => {
  await withCallerHarness({ realConnections: true }, async ({ caller, service, proxy }) => {
    await proxy.close();
    assert.deepEqual(await caller.call(serviceRequest(service.origin)), failure('service-unreachable'));
    assert.deepEqual(service.received, [], 'the caller went round the proxy');
  });
});

// ---- A write is sent once ----------------------------------------------------------------------------

const createOrder = (target: string) => serviceRequest(target, {
  method: 'POST', pathAndQuery: '/api/orders', body: ['{"customer":"Ada Lovelace","quantity":2}'], timeoutMilliseconds: TIMEOUT,
});

test('a write that times out was received by the service exactly once', { criterion: 'AC-SPEC-32-09' }, async () => {
  await withCallerHarness({ answer: silentAnswer }, async ({ caller, service }) => {
    assert.deepEqual(await caller.call(createOrder(service.origin)), failure('call-timeout'));
    await settle(TIMEOUT * 3);
    assert.deepEqual(paths(service.received), ['POST /api/orders']);
    assert.equal(service.received[0]?.body, '{"customer":"Ada Lovelace","quantity":2}');
  });
});

test('a write whose connection drops after the service received it fails and is not sent again', { criterion: 'AC-SPEC-32-09' }, async () => {
  await withCallerHarness({ answer: droppedAnswer }, async ({ caller, service }) => {
    const answered = await caller.call(createOrder(service.origin));
    assert.equal(answered.ok, false, JSON.stringify(answered));
    await settle(TIMEOUT * 3);
    assert.deepEqual(paths(service.received), ['POST /api/orders']);
  });
});

test('a write answered 503 is returned as received and not sent again', { criterion: 'AC-SPEC-32-09' }, async () => {
  await withCallerHarness({ answer: jsonAnswer(503, { error: 'busy' }) }, async ({ caller, service }) => {
    const answered = await caller.call(createOrder(service.origin));
    assert.ok(answered.ok, JSON.stringify(answered));
    assert.equal(answered.value.status, 503);
    await settle(TIMEOUT);
    assert.deepEqual(paths(service.received), ['POST /api/orders']);
  });
});

// ---- Reading stops at the size cap -------------------------------------------------------------------

const CAP = 1024;

test('a response of exactly maximumResponseBytes is read whole', { criterion: 'AC-SPEC-32-10' }, async () => {
  await withCallerHarness({ answer: sizedAnswer(CAP) }, async ({ caller, service }) => {
    const answered = await caller.call(serviceRequest(service.origin, { maximumResponseBytes: CAP }));
    assert.ok(answered.ok, JSON.stringify(answered));
    assert.equal(answered.value.body.length, CAP);
    assert.equal(bodyAsText(answered.value.body), 'a'.repeat(CAP));
  });
});

for (const [name, chunked] of [['with its length declared', false], ['sent chunked, with no length', true]] as const) {
  test(`a response one byte over maximumResponseBytes, ${name}, fails with response-too-large`, { criterion: 'AC-SPEC-32-10' }, async () => {
    await withCallerHarness({ answer: sizedAnswer(CAP + 1, chunked) }, async ({ caller, service }) => {
      assert.deepEqual(await caller.call(serviceRequest(service.origin, { maximumResponseBytes: CAP })), failure('response-too-large'));
    });
  });
}

test('reading stops at the cap: an endless response ends the call long before the service could send it all', { criterion: 'AC-SPEC-32-10', timeout: 60_000 }, async () => {
  const total = 512 * 1024 * 1024;
  const endless = endlessAnswer(total);
  await withCallerHarness({ answer: endless.answer }, async ({ caller, service }) => {
    const answered = await caller.call(serviceRequest(service.origin, { maximumResponseBytes: 4096, timeoutMilliseconds: 30_000 }));
    const sentWhenAnswered = endless.sentBytes();
    assert.deepEqual(answered, failure('response-too-large'));
    assert.ok(sentWhenAnswered < total / 8, `the service had sent ${sentWhenAnswered} of ${total} bytes when the caller answered`);
  });
});

// ---- Header values stay on the wire --------------------------------------------------------------------

const HEADER_MARKER = 'caller-header-q7zx';

test('the caller reveals secret headers and body parts only on the wire: the console holds no header value', { criterion: 'AC-SPEC-32-11' }, async () => {
  const token = fakeSecretValue();
  const login = `qa-login-${fakeSecretValue()}`;
  const password = fakeSecretValue();
  const loginForm = Buffer.from(login).toString('base64');
  // The service echoes everything it received, in its body and in a header of its own.
  const echoing: Answer = (received, response) => {
    response.writeHead(201, { 'content-type': 'application/json', 'x-echo': encodeURIComponent(JSON.stringify(received.headers)) })
      .end(JSON.stringify({ headers: received.headers, body: received.body }));
  };
  await withCallerHarness({ answer: echoing }, async ({ caller, service, proxy }) => {
    const request = serviceRequest(service.origin, {
      method: 'POST', pathAndQuery: '/api/test/sessions',
      headers: [
        { name: 'authorization', value: resolvedSecret('SHOP_API_TOKEN', `Bearer ${token}`) },
        { name: 'x-admin-login', value: resolvedSecret('SHOP_ADMIN_LOGIN', `Basic ${loginForm}`) },
        { name: 'x-test-suite', value: HEADER_MARKER },
      ],
      body: ['{"password":', resolvedSecret('SHOP_ADMIN_PASSWORD', password), '}'],
    });
    let answered: Awaited<ReturnType<typeof caller.call>> | undefined;
    const consoleText = await consoleWrittenDuring(async () => { answered = await caller.call(request); });

    // The probe is live: the secrets reached the service, so a leak had something to leak.
    assert.ok(answered?.ok, JSON.stringify(answered));
    const sent = service.received[0];
    assert.equal(sent?.headers.authorization, `Bearer ${token}`);
    assert.equal(sent?.headers['x-admin-login'], `Basic ${loginForm}`);
    assert.equal(sent?.headers['x-test-suite'], HEADER_MARKER);
    assert.deepEqual(JSON.parse(sent?.body ?? ''), { password });

    for (const [name, value] of [['token', token], ['login', login], ['password', password]] as const) {
      assert.deepEqual(echoesIn(consoleText, value), [], `the ${name} reached the console`);
    }
    assert.ok(!consoleText.includes(loginForm), 'the basic header reached the console');
    assert.ok(!consoleText.includes(HEADER_MARKER), 'a literal header value reached the console');
    assert.ok(!JSON.stringify(proxy.decisions()).includes(HEADER_MARKER), 'a header value reached the proxy\'s decisions');
  });
});

test('a failed call with secret headers answers with its code alone, and the console holds no header value', { criterion: 'AC-SPEC-32-11' }, async () => {
  const token = fakeSecretValue();
  await withCallerHarness({ answer: silentAnswer }, async ({ caller, service }) => {
    let answered: Awaited<ReturnType<typeof caller.call>> | undefined;
    const consoleText = await consoleWrittenDuring(async () => {
      answered = await caller.call(serviceRequest(service.origin, {
        headers: [{ name: 'authorization', value: resolvedSecret('SHOP_API_TOKEN', `Bearer ${token}`) }, { name: 'x-test-suite', value: HEADER_MARKER }],
        timeoutMilliseconds: TIMEOUT,
      }));
    });
    assert.deepEqual(answered, failure('call-timeout'));
    assert.deepEqual(echoesIn(consoleText, token), []);
    assert.ok(!consoleText.includes(HEADER_MARKER));
  });
});

// Mutant: a caller that logged its headers would be caught, so the console checks above can fail.
test('mutant: a header value written to the console during a call is caught by the console copy', { criterion: 'AC-SPEC-32-11' }, async () => {
  const token = fakeSecretValue();
  const consoleText = await consoleWrittenDuring(async () => { console.log(`authorization: Bearer ${token}; x-test-suite: ${HEADER_MARKER}`); });
  assert.notDeepEqual(echoesIn(consoleText, token), []);
  assert.ok(consoleText.includes(HEADER_MARKER));
});
