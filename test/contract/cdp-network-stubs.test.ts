// Declared stubs on the own CDP driver. A stub answers only the page's fetch and XHR requests that
// match it, with data and nosniff, so script markup in its body stays text; a document, script,
// style sheet, frame, worker or image request that matches goes to the server instead. Its
// responses are served in order and the last repeats; after a stop, requests reach the server.
// The result records which stub and which response answered each request, so 20 replays give one
// result hash. Every assertion that runs while a stub is active lists the active stubs, so a
// report can say the check ran against a faked response.
// Each claim has its counter-example: the same bytes served as a page do run their script, and
// without the stub the same requests reach the server.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGET, SERVER_ASSETS, activeStubsOf, click, expectRequests, expectResponse, expectStorage, navigate, networkHarness, networkPlan,
  outcomes, role, startStub, stopStub, stubbedAnswersIn, testId, textEquals, timesRequested, titleIs, visible,
  type NetworkHarness, type NetworkRun,
} from './network-stubs-support.ts';

let harness: NetworkHarness;
before(async () => { harness = await networkHarness(); });
after(async () => { await harness.close(); });

const assertPassed = (ran: NetworkRun): void => assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));

describe('a stub serves data only, to fetch and XHR only', () => {
  test('a fixture body holding script markup reaches the page\'s fetch as JSON with nosniff, and no script runs', { criterion: 'AC-SPEC-33-03' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/resources.html'),
      startStub('markupNotes'),
      click(role('button', 'Load notes')),
      textEquals(testId('notes-kind'), 'Markup kept as text', 'stubs.markup-is-text'),
      textEquals(testId('notes-type'), 'application/json', 'stubs.served-as-json'),
      textEquals(testId('notes-sniffing'), 'nosniff', 'stubs.nosniff-sent'),
      textEquals(testId('script-runs'), '0', 'stubs.no-script-ran'),
      stopStub('markupNotes'),
    ], { read: ['script-runs'] });
    assertPassed(ran);
    assert.equal(ran.atClose?.shown['script-runs'], '0', 'no script ran by the time the session closed');
    assert.equal(timesRequested(ran.requestedPaths, '/api/notes'), 0, 'the stub answered; the server was never asked');
  });

  // Counter-example: the script counter is live. The same fixture bytes served as an HTML page in
  // a frame do run their markup, and the counter shows it.
  test('counter-example: the same bytes served as an HTML page in a frame run their script, and the counter shows it', { criterion: 'AC-SPEC-33-03' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/resources.html'),
      click(role('button', 'Show the notes as a page')),
      textEquals(testId('script-runs'), '1', 'stubs.page-script-ran'),
    ]);
    assertPassed(ran);
  });

  test('counter-example: without the stub, the same fetch gets the server\'s notes', { criterion: 'AC-SPEC-33-03' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/resources.html'),
      click(role('button', 'Load notes')),
      textEquals(testId('notes-kind'), 'No markup received', 'stubs.server-notes'),
    ]);
    assertPassed(ran);
    assert.equal(timesRequested(ran.requestedPaths, '/api/notes'), 1);
  });

  test('a script, style sheet, frame, worker, image and document that match a stub go to the server; its fetch and XHR get the stub', { criterion: 'AC-SPEC-33-03' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/resources.html'),
      startStub('assetRequests'),
      click(role('button', 'Load every resource')),
      textEquals(testId('script-state'), 'Script from server', 'stubs.script-not-stubbed'),
      textEquals(testId('style-state'), 'Style from server', 'stubs.style-not-stubbed'),
      textEquals(testId('frame-state'), 'Frame from server', 'stubs.frame-not-stubbed'),
      textEquals(testId('worker-state'), 'Worker from server', 'stubs.worker-not-stubbed'),
      textEquals(testId('image-state'), 'Image from server', 'stubs.image-not-stubbed'),
      textEquals(testId('fetch-state'), 'Fetch: stub answered', 'stubs.fetch-stubbed'),
      textEquals(testId('xhr-state'), 'XHR: stub answered', 'stubs.xhr-stubbed'),
      // A document request under the stub's prefix, while the stub is still active.
      navigate('/api/assets/page.html'),
      textEquals(testId('document-source'), 'Document from server', 'stubs.document-not-stubbed'),
      stopStub('assetRequests'),
    ]);
    assertPassed(ran);
    for (const path of Object.keys(SERVER_ASSETS)) {
      assert.equal(timesRequested(ran.requestedPaths, path), 1, `${path} went to the server once`);
    }
    assert.equal(timesRequested(ran.requestedPaths, '/api/assets/data.json'), 0, 'the fetch and the XHR never reached the server');
  });

  test('counter-example: without the stub, the same fetch and XHR reach the server', { criterion: 'AC-SPEC-33-03' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/resources.html'),
      click(role('button', 'Load every resource')),
      textEquals(testId('fetch-state'), 'Fetch: server answered', 'stubs.fetch-from-server'),
      textEquals(testId('xhr-state'), 'XHR: server answered', 'stubs.xhr-from-server'),
    ]);
    assertPassed(ran);
    assert.equal(timesRequested(ran.requestedPaths, '/api/assets/data.json'), 2);
  });
});

// Five questions while the stub answers, then a stop and one more, which reaches the server.
const ask = () => click(role('button', 'Ask for the next answer'));
const answersShown = (text: string, criterionId: string) => textEquals(testId('answers'), text, criterionId);
const sequenceSteps = (stubbedQuestions: number): unknown[] => {
  const expected = ['1', '2', '3', '3', '3', '3', '3'].slice(0, stubbedQuestions);
  const steps: unknown[] = [navigate('/requests.html'), startStub('answerSequence')];
  expected.forEach((_, index) => steps.push(ask(), answersShown(expected.slice(0, index + 1).join(' '), `sequence.answer-${index + 1}`)));
  steps.push(stopStub('answerSequence'), ask(), answersShown([...expected, 'server'].join(' '), 'sequence.server-after-stop'));
  return steps;
};

describe('a stub\'s responses are served in order, and the last repeats', () => {
  test('a stub with three responses answers five requests with responses 1, 2, 3, 3 and 3; after its stop the server answers', { criterion: 'AC-SPEC-33-04' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, sequenceSteps(5));
    assertPassed(ran);
    assert.equal(timesRequested(ran.requestedPaths, '/api/sequence'), 1, 'only the request after the stop reached the server');
  });

  test('the result records the stub name and the response index of each stubbed request, and none for the request after the stop', { criterion: 'AC-SPEC-33-04' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, sequenceSteps(5));
    assertPassed(ran);
    const answers = stubbedAnswersIn(ran.result);
    assert.deepEqual(answers.map((answer) => answer.stub), Array(5).fill('answerSequence'), JSON.stringify(answers));
    // The index counts from the stub's first response, whether the result counts it as 0 or 1.
    const first = answers[0]?.responseIndex ?? -1;
    assert.ok(first === 0 || first === 1, `the first answer is the stub's first response: ${JSON.stringify(answers)}`);
    assert.deepEqual(answers.map((answer) => answer.responseIndex - first), [0, 1, 2, 2, 2]);
  });

  test('20 replays of the same stubbed plan give one result hash', { criterion: 'AC-SPEC-33-04', timeout: 600_000 }, async () => {
    const plan = harness.plan(networkPlan(CDP_TARGET, sequenceSteps(5)));
    const hashes = new Set<string>();
    for (let replay = 0; replay < 20; replay++) {
      const ran = await harness.run(plan, CDP_TARGET);
      assert.equal(ran.result.state, 'Passed', `replay ${replay}: ${JSON.stringify(ran.result.steps)}`);
      hashes.add(ran.result.resultHash);
    }
    assert.equal(hashes.size, 1, 'every replay gives the same result hash');
  });

  // Counter-example: one hash across the replays is not a hash that ignores the stubbed requests.
  test('counter-example: the plan with one stubbed request fewer gives another result hash', { criterion: 'AC-SPEC-33-04', timeout: 120_000 }, async () => {
    const five = await harness.runSteps(CDP_TARGET, sequenceSteps(5));
    const four = await harness.runSteps(CDP_TARGET, sequenceSteps(4));
    assertPassed(five);
    assertPassed(four);
    assert.deepEqual(stubbedAnswersIn(four.result).length, 4);
    assert.notEqual(five.result.resultHash, four.result.resultHash);
  });
});

describe('assertions name the stubs active while they ran', () => {
  test('every kind of assertion lists the stubs active while it ran, and none once they are stopped', { criterion: 'AC-SPEC-33-14' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/requests.html'),
      textEquals(testId('schedule-state'), 'Schedule loaded', 'active.before-any-stub'),
      startStub('answerSequence'),
      startStub('assetRequests'),
      ask(),
      answersShown('1', 'active.element-check'),
      titleIs('Requests', 'active.page-check'),
      expectRequests('sequence', { equals: 1 }, 'active.request-count'),
      expectResponse('scheduleLoads', { kind: 'statusEquals', value: 200 }, 'active.response-check'),
      expectStorage('menuDocked', { kind: 'absent' }, 'active.storage-check'),
      stopStub('assetRequests'),
      visible(testId('answers'), 'active.one-stub-left'),
      stopStub('answerSequence'),
      titleIs('Requests', 'active.after-every-stop'),
    ]);
    assertPassed(ran);
    const both = ['answerSequence', 'assetRequests'];
    const listed = (index: number) => activeStubsOf(ran.result.steps[index]);
    assert.deepEqual(listed(1), [], 'a check before any stub lists none');
    for (const index of [5, 6, 7, 8, 9]) {
      assert.deepEqual(listed(index), both, `step ${index} (${ran.result.steps[index]?.type ?? ''}) lists both active stubs`);
    }
    assert.deepEqual(listed(11), ['answerSequence'], 'a check after one stop lists the stub still active');
    assert.deepEqual(listed(13), [], 'a check after every stop lists none');
  });

  test('a failed assertion while a stub is active lists it too', { criterion: 'AC-SPEC-33-14' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/requests.html'),
      startStub('answerSequence'),
      ask(),
      answersShown('deliberately wrong', 'active.failed-check'),
    ]);
    assert.deepEqual(outcomes(ran.result).at(-1), [3, 'failed', 'assertion-failed']);
    assert.deepEqual(activeStubsOf(ran.result.steps[3]), ['answerSequence']);
  });
});
