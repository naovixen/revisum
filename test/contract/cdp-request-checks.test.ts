// Request checks on the own CDP driver: counting the exchanges an observed request saw, checking
// the latest response, and remembering one of its fields.
//
//   - Counts. "Load two batches" sends exactly two GET requests to /api/items, the second 300 ms
//     after the first and answered slowly, beside two requests that do not match. equals 2 and
//     atLeast 1 pass; equals 1 and atMost 1 fail; after resetRequests, equals 0 passes. equals and
//     atMost wait for the project's quiet window, so a count right after the click still sees the
//     second request.
//   - Responses. statusEquals and fieldEquals check the latest exchange, and fail as they should:
//     a body over the request's cap with response-too-large, a body that is not JSON with
//     response-not-json, a pointer with nothing there with field-missing, and no exchange at all
//     with request-not-seen.
//   - Remember. arrayLength gives the decimal length of an array and fails with field-missing on
//     anything else.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sha256 } from '@revisum/engine';
import {
  CDP_TARGET, ITEM_NAMES, NEXT_PAGE_FIRST_ITEM, QUIET_MILLISECONDS, click, expectRequests, expectResponse, navigate, networkHarness, outcomes,
  reference, rememberResponse, resetRequests, role, testId, textEquals, type JsonRecord, type NetworkHarness, type NetworkRun,
} from './network-stubs-support.ts';

let harness: NetworkHarness;
before(async () => { harness = await networkHarness(); });
after(async () => { await harness.close(); });

const assertPassed = (ran: NetworkRun): void => assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));

// The last step failed with `code`; every step before it passed.
function assertLastStepFailed(ran: NetworkRun, code: string): void {
  const all = outcomes(ran.result);
  const last = all.length - 1;
  assert.deepEqual(all.slice(0, last).filter(([, outcome]) => outcome !== 'passed'), [], `the steps before the last passed: ${JSON.stringify(ran.result.steps)}`);
  assert.deepEqual(all[last], [last, 'failed', code], JSON.stringify(ran.result.steps));
}

const loadTwoBatches = () => click(role('button', 'Load two batches'));
const openRequests = () => navigate('/requests.html');

describe('counting the requests an observed request saw', () => {
  test('equals 2 and atLeast 1 pass on a page that sent exactly two matching requests', { criterion: 'AC-SPEC-33-07' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(),
      loadTwoBatches(),
      textEquals(testId('batches-state'), 'Both batches loaded', 'counts.batches-loaded'),
      expectRequests('items', { equals: 2 }, 'counts.exactly-two'),
      expectRequests('items', { atLeast: 1 }, 'counts.at-least-one'),
      expectRequests('items', { atMost: 2 }, 'counts.at-most-two'),
    ]);
    assertPassed(ran);
    assert.equal(ran.requestedPaths.filter((path) => path === '/api/items').length, 3, 'the server saw two GETs and one POST to /api/items');
  });

  for (const count of [{ equals: 1 }, { atMost: 1 }, { equals: 3 }]) {
    test(`${JSON.stringify(count)} fails on a page that sent exactly two matching requests`, { criterion: 'AC-SPEC-33-07' }, async () => {
      const ran = await harness.runSteps(CDP_TARGET, [
        openRequests(),
        loadTwoBatches(),
        textEquals(testId('batches-state'), 'Both batches loaded', 'counts.batches-loaded'),
        expectRequests('items', count, 'counts.wrong-count'),
      ]);
      assertLastStepFailed(ran, 'assertion-failed');
    });
  }

  test('after resetRequests, equals 0 passes and atLeast 1 counts only what comes next', { criterion: 'AC-SPEC-33-07' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(),
      loadTwoBatches(),
      textEquals(testId('batches-state'), 'Both batches loaded', 'counts.batches-loaded'),
      resetRequests('items'),
      expectRequests('items', { equals: 0 }, 'counts.none-since-reset'),
      click(role('button', 'Load items')),
      expectRequests('items', { equals: 1 }, 'counts.one-since-reset'),
    ]);
    assertPassed(ran);
  });

  test('counter-example: without resetRequests, equals 0 fails after the two requests', { criterion: 'AC-SPEC-33-07' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(),
      loadTwoBatches(),
      textEquals(testId('batches-state'), 'Both batches loaded', 'counts.batches-loaded'),
      expectRequests('items', { equals: 0 }, 'counts.none-without-reset'),
    ]);
    assertLastStepFailed(ran, 'assertion-failed');
  });

  test('requests the page sent while it loaded count from the start of the plan', { criterion: 'AC-SPEC-33-07' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(),
      expectRequests('scheduleLoads', { equals: 1 }, 'counts.loaded-with-page'),
    ]);
    assertPassed(ran);
  });

  // Straight after the click only the first request has been sent: the second follows 300 ms
  // later and is answered over 600 ms more. A count that did not wait for the quiet window would
  // see one request, so equals 2 would fail and atMost 1 would pass.
  test('equals 2 straight after the click waits for the quiet window, sees both requests and passes', { criterion: 'AC-SPEC-33-07' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(),
      loadTwoBatches(),
      expectRequests('items', { equals: 2 }, 'counts.quiet-equals'),
    ]);
    assertPassed(ran);
    const waited = ran.result.timings.stepMilliseconds[2] ?? 0;
    assert.ok(waited >= QUIET_MILLISECONDS, `the count waited ${waited} ms, at least the quiet window of ${QUIET_MILLISECONDS} ms`);
  });

  test('atMost 1 straight after the click waits for the quiet window, sees both requests and fails', { criterion: 'AC-SPEC-33-07' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(),
      loadTwoBatches(),
      expectRequests('items', { atMost: 1 }, 'counts.quiet-at-most'),
    ]);
    assertLastStepFailed(ran, 'assertion-failed');
  });
});

const loadItems = () => click(role('button', 'Load items'));
const itemsShown = () => textEquals(testId('first-item'), ITEM_NAMES[0], 'responses.items-shown');

describe('checking the latest response', () => {
  test('statusEquals, fieldEquals, fieldContains, fieldPresent and fieldAbsent pass on the latest exchange', { criterion: 'AC-SPEC-33-08' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(),
      loadItems(),
      itemsShown(),
      expectResponse('items', { kind: 'statusEquals', value: 200 }, 'responses.status'),
      expectResponse('items', { kind: 'fieldEquals', field: 'firstName', value: ITEM_NAMES[0] }, 'responses.first-name'),
      expectResponse('items', { kind: 'fieldContains', field: 'firstName', value: 'ettl' }, 'responses.first-name-part'),
      expectResponse('items', { kind: 'fieldPresent', field: 'itemList' }, 'responses.list-present'),
      expectResponse('items', { kind: 'fieldAbsent', field: 'nothing' }, 'responses.nothing-absent'),
      click(role('button', 'Load the next page')),
      textEquals(testId('first-item'), NEXT_PAGE_FIRST_ITEM, 'responses.next-page-shown'),
      expectResponse('items', { kind: 'fieldEquals', field: 'firstName', value: NEXT_PAGE_FIRST_ITEM }, 'responses.latest-first-name'),
    ]);
    assertPassed(ran);
  });

  test('statusEquals passes on a 404 answer that the page received', { criterion: 'AC-SPEC-33-08' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(),
      click(role('button', 'Load missing items')),
      textEquals(testId('missing-state'), 'Missing items answered 404', 'responses.missing-shown'),
      expectResponse('missingItems', { kind: 'statusEquals', value: 404 }, 'responses.status-404'),
    ]);
    assertPassed(ran);
  });

  const FAILURES: readonly { readonly name: string; readonly steps: () => unknown[]; readonly code: string }[] = [
    {
      name: 'statusEquals with another status fails', code: 'assertion-failed',
      steps: () => [loadItems(), itemsShown(), expectResponse('items', { kind: 'statusEquals', value: 500 }, 'responses.wrong-status')],
    },
    {
      name: 'fieldEquals with another value fails', code: 'assertion-failed',
      steps: () => [loadItems(), itemsShown(), expectResponse('items', { kind: 'fieldEquals', field: 'firstName', value: 'Toaster' }, 'responses.wrong-name')],
    },
    {
      // The first page's name, once the latest exchange is the next page's.
      name: 'fieldEquals with an earlier exchange\'s value fails, since only the latest is checked', code: 'assertion-failed',
      steps: () => [
        loadItems(), itemsShown(), click(role('button', 'Load the next page')),
        textEquals(testId('first-item'), NEXT_PAGE_FIRST_ITEM, 'responses.next-page-shown'),
        expectResponse('items', { kind: 'fieldEquals', field: 'firstName', value: ITEM_NAMES[0] }, 'responses.earlier-name'),
      ],
    },
    {
      name: 'fieldAbsent on a field that is there fails', code: 'assertion-failed',
      steps: () => [loadItems(), itemsShown(), expectResponse('items', { kind: 'fieldAbsent', field: 'firstName' }, 'responses.name-absent')],
    },
    {
      name: 'a field read from a body over the request\'s cap fails with response-too-large', code: 'response-too-large',
      steps: () => [
        click(role('button', 'Load big items')), textEquals(testId('big-state'), 'Big items loaded', 'responses.big-shown'),
        expectResponse('bigItems', { kind: 'fieldEquals', field: 'firstName', value: 'Archived kettle number 0' }, 'responses.big-name'),
      ],
    },
    {
      name: 'a field read from a body that is not JSON fails with response-not-json', code: 'response-not-json',
      steps: () => [
        click(role('button', 'Load plain items')), textEquals(testId('plain-state'), 'Plain items loaded', 'responses.plain-shown'),
        expectResponse('plainItems', { kind: 'fieldEquals', field: 'firstName', value: 'Kettle' }, 'responses.plain-name'),
      ],
    },
    {
      name: 'a field whose pointer finds nothing fails with field-missing', code: 'field-missing',
      steps: () => [loadItems(), itemsShown(), expectResponse('items', { kind: 'fieldEquals', field: 'nothing', value: 'anything' }, 'responses.nothing-there')],
    },
    {
      name: 'a check of a request the page never sent fails with request-not-seen', code: 'request-not-seen',
      steps: () => [loadItems(), itemsShown(), expectResponse('neverSent', { kind: 'statusEquals', value: 200 }, 'responses.never-sent')],
    },
    {
      name: 'a field check of a request the page never sent fails with request-not-seen', code: 'request-not-seen',
      steps: () => [loadItems(), itemsShown(), expectResponse('neverSent', { kind: 'fieldPresent', field: 'firstName' }, 'responses.never-sent-field')],
    },
  ];

  for (const failure of FAILURES) {
    test(failure.name, { criterion: 'AC-SPEC-33-08' }, async () => {
      const ran = await harness.runSteps(CDP_TARGET, [openRequests(), ...failure.steps()]);
      assertLastStepFailed(ran, failure.code);
    });
  }

  // Counter-example: the same field of a body under the cap is read, so the size failure above
  // comes from the cap, not from the field.
  test('counter-example: the same field check on a body under the cap passes', { criterion: 'AC-SPEC-33-08' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(), loadItems(), itemsShown(),
      expectResponse('items', { kind: 'fieldPresent', field: 'firstName' }, 'responses.under-cap'),
    ]);
    assertPassed(ran);
  });
});

const remembered = (ran: NetworkRun, index: number): JsonRecord | undefined => {
  const record = ran.result.steps[index]?.remembered;
  return record === undefined ? undefined : { valueName: record.valueName, sha256: record.sha256 };
};

describe('remembering a response field', () => {
  test('arrayLength remembers the decimal length of an array, which a later check uses', { criterion: 'AC-SPEC-33-09' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(), loadItems(), itemsShown(),
      rememberResponse('itemCount', 'items', 'itemList', 'arrayLength'),
      textEquals(testId('item-count'), reference('itemCount'), 'remember.count-shown'),
    ]);
    assertPassed(ran);
    assert.deepEqual(remembered(ran, 3), { valueName: 'itemCount', sha256: sha256(String(ITEM_NAMES.length)) }, 'the value is "12"');
  });

  test('text remembers a field\'s text', { criterion: 'AC-SPEC-33-09' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(), loadItems(), itemsShown(),
      rememberResponse('firstItem', 'items', 'firstName', 'text'),
      textEquals(testId('first-item'), reference('firstItem'), 'remember.name-shown'),
    ]);
    assertPassed(ran);
    assert.deepEqual(remembered(ran, 3), { valueName: 'firstItem', sha256: sha256(ITEM_NAMES[0]) });
  });

  for (const field of ['firstName', 'total']) {
    test(`arrayLength of a field that is not an array (${field}) fails with field-missing`, { criterion: 'AC-SPEC-33-09' }, async () => {
      const ran = await harness.runSteps(CDP_TARGET, [
        openRequests(), loadItems(), itemsShown(),
        rememberResponse('notAList', 'items', field, 'arrayLength'),
        textEquals(testId('item-count'), reference('notAList'), 'remember.never-checked'),
      ]);
      assert.deepEqual(outcomes(ran.result).slice(3), [[3, 'failed', 'field-missing'], [4, 'skipped', undefined]], JSON.stringify(ran.result.steps));
    });
  }

  test('a remember from a request the page never sent fails with request-not-seen', { criterion: 'AC-SPEC-33-09' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openRequests(), loadItems(), itemsShown(),
      rememberResponse('neverCount', 'neverSent', 'firstName', 'text'),
      textEquals(testId('item-count'), reference('neverCount'), 'remember.never-checked'),
    ]);
    assert.deepEqual(outcomes(ran.result).slice(3), [[3, 'failed', 'request-not-seen'], [4, 'skipped', undefined]], JSON.stringify(ran.result.steps));
  });
});
