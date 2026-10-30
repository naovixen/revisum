// Stubs and request checks see past a service worker. The fixture page registers a service worker
// that answers /api/worker-items itself, without the network (fixtures/network-stubs-app/
// service-worker.js; http://127.0.0.1 is a secure context, so the worker installs). While a stub
// or a request check is active, the own CDP driver bypasses service workers, so the stub answers
// every matching request and the check sees every one.
// The counter-example runs the same page with no stub and no check: the worker answers, and the
// server never sees the request, so the worker is live and the bypass is what the tests show.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  CDP_TARGET, click, expectRequests, expectResponse, navigate, networkHarness, role, startStub, stopStub, testId, textEquals, timesRequested,
  type NetworkHarness, type NetworkRun,
} from './network-stubs-support.ts';

let harness: NetworkHarness;
before(async () => { harness = await networkHarness(); });
after(async () => { await harness.close(); });

const assertPassed = (ran: NetworkRun): void => assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
const openWorkerPage = () => [
  navigate('/workers.html'),
  textEquals(testId('worker-state'), 'Worker ready', 'worker.controls-page'),
];
const loadItems = () => click(role('button', 'Load worker items'));
const answered = (source: string, count: number, criterionId: string) => [
  textEquals(testId('answer-count'), String(count), `${criterionId}-count`),
  textEquals(testId('items-source'), source, criterionId),
];

test('counter-example: with no stub and no request check, the service worker answers the page and the server never sees the request', { criterion: 'AC-SPEC-33-06' }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [...openWorkerPage(), loadItems(), ...answered('service worker', 1, 'worker.answered-itself')]);
  assertPassed(ran);
  assert.equal(timesRequested(ran.requestedPaths, '/api/worker-items'), 0);
});

test('an active stub answers every matching request of a page a service worker controls', { criterion: 'AC-SPEC-33-06' }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    ...openWorkerPage(),
    startStub('workerItems'),
    loadItems(), ...answered('stub', 1, 'worker.stub-first'),
    loadItems(), ...answered('stub', 2, 'worker.stub-second'),
    loadItems(), ...answered('stub', 3, 'worker.stub-third'),
    stopStub('workerItems'),
  ]);
  assertPassed(ran);
  assert.equal(timesRequested(ran.requestedPaths, '/api/worker-items'), 0, 'the stub answered; nothing reached the server');
});

test('an active request check sees every matching request of a page a service worker controls', { criterion: 'AC-SPEC-33-06' }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    ...openWorkerPage(),
    loadItems(), ...answered('server', 1, 'worker.check-first'),
    loadItems(), ...answered('server', 2, 'worker.check-second'),
    expectRequests('workerItems', { equals: 2 }, 'worker.both-seen'),
    expectResponse('workerItems', { kind: 'fieldEquals', field: 'source', value: 'server' }, 'worker.response-seen'),
  ]);
  assertPassed(ran);
  assert.equal(timesRequested(ran.requestedPaths, '/api/worker-items'), 2, 'every request went past the worker to the server');
});

test('a stub and a request check together: the check counts each request the stub answered', { criterion: 'AC-SPEC-33-06' }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    ...openWorkerPage(),
    startStub('workerItems'),
    loadItems(), ...answered('stub', 1, 'worker.both-first'),
    loadItems(), ...answered('stub', 2, 'worker.both-second'),
    expectRequests('workerItems', { equals: 2 }, 'worker.stubbed-seen'),
    expectResponse('workerItems', { kind: 'fieldEquals', field: 'source', value: 'stub' }, 'worker.stubbed-response-seen'),
    stopStub('workerItems'),
  ]);
  assertPassed(ran);
  assert.equal(timesRequested(ran.requestedPaths, '/api/worker-items'), 0);
});
