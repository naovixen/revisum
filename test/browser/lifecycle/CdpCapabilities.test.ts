// The capabilities the own CDP driver adds for the plan language: steps inside an iframe, answering
// a dialog, uploading a declared fixture file, and a tab that crashes. Each capability test repeats
// determinismRuns() times in a row and every run must pass; the iframe, dialog and upload tests
// repeat their steps in one plan, so one browser serves them all with a fresh page load each time,
// and the crash test runs one plan per repetition, since a crashed tab ends its session.
// Single-run tests below them pin what each capability means: a frame's steps reach only the
// frame's document, a dialog is accepted or dismissed as asked and its text is checked, and the
// uploaded file's name and bytes reach the page.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunResult } from '@revisum/engine';
import { BROWSERS } from '#test-support/browser/Browsers.ts';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { click, label, navigate, role, testId, textEquals } from '#test-support/browser/RawPlan.ts';
import { UPLOAD_CONTENT, UPLOAD_FIXTURE, capabilityCdpDriver, capabilityDrivers, capabilityHarness, capabilityPlan, watchedDriver, type CapabilityHarness } from '#test-support/browser/harnesses/CapabilityHarness.ts';
import { CRASH_READY_PATH, crashWhenRequested } from '#test-support/browser/harnesses/CrashWhenRequested.ts';
import { determinismRuns } from '#test-support/TestTier.ts';

const REPETITIONS = determinismRuns();
// Long enough for the test to find and end the renderer while the step waits, even where listing
// processes takes a second or more.
const CRASH_STEP_TIMEOUT_MILLISECONDS = 8000;

let capability: CapabilityHarness;
before(async () => { capability = await capabilityHarness(CRASH_STEP_TIMEOUT_MILLISECONDS); });
after(async () => { await capability.close(); });

const repeated = (block: readonly unknown[]): unknown[] => Array.from({ length: REPETITIONS }, () => block).flat();

// Every step passed; on a failure, which repetition and which step of it failed, and how.
function assertEveryStepPassed(result: RunResult, blockLength: number): void {
  const failed = result.steps.find((step) => step.outcome !== 'passed');
  const where = failed === undefined ? '' : `repetition ${Math.floor(failed.index / blockLength) + 1}, step ${failed.index % blockLength} (${failed.type}): ${failed.outcome} ${failed.code ?? ''}`;
  assert.equal(result.state, 'Passed', where);
  assert.equal(result.steps.length, blockLength * REPETITIONS);
}

const FRAME_BLOCK = [
  navigate('/frame.html'),
  {
    type: 'frame', locator: testId('checkout-frame'), steps: [
      { type: 'fill', locator: label('Card holder'), value: 'Ada Lovelace' },
      click(role('button', 'Confirm order')),
      textEquals(testId('frame-status'), 'Confirmed for Ada Lovelace', 'frame.inner-confirmed'),
    ],
  },
  textEquals(testId('outer-status'), 'Not confirmed', 'frame.outer-untouched'),
];

const DIALOG_BLOCK = [
  navigate('/dialog.html'),
  click(role('button', 'Ask a question')),
  { type: 'dialog', action: 'accept', expectText: 'Keep the draft?' },
  textEquals(testId('dialog-status'), 'Kept', 'dialog.accepted'),
  click(role('button', 'Ask a question')),
  { type: 'dialog', action: 'dismiss' },
  textEquals(testId('dialog-status'), 'Discarded', 'dialog.dismissed'),
];

const UPLOAD_BLOCK = [
  navigate('/upload.html'),
  { type: 'upload', locator: label('Attachment'), fixture: UPLOAD_FIXTURE },
  textEquals(testId('upload-name'), UPLOAD_FIXTURE, 'upload.name-shown'),
  textEquals(testId('upload-content'), UPLOAD_CONTENT, 'upload.content-shown'),
];

const CRASH_PLAN_STEPS = [
  navigate('/crash.html'),
  click(role('button', 'Start the report')),
  textEquals(testId('crash-status'), 'Waiting', 'crash.never-reached'),
  { type: 'capture', name: 'after-crash' },
];

describe(`${REPETITIONS} runs of each capability on Chrome for Testing`, () => {
  test(`steps inside an iframe pass in all ${REPETITIONS} runs`, async () => {
    const { result } = await capability.run(capability.plan(capabilityPlan(BrowserTarget.Chrome, repeated(FRAME_BLOCK))), BrowserTarget.Chrome);
    assertEveryStepPassed(result, FRAME_BLOCK.length);
  });

  test(`accepting and dismissing a dialog pass in all ${REPETITIONS} runs`, async () => {
    const { result } = await capability.run(capability.plan(capabilityPlan(BrowserTarget.Chrome, repeated(DIALOG_BLOCK))), BrowserTarget.Chrome);
    assertEveryStepPassed(result, DIALOG_BLOCK.length);
  });

  test(`uploading the declared fixture file passes in all ${REPETITIONS} runs`, async () => {
    const { result } = await capability.run(capability.plan(capabilityPlan(BrowserTarget.Chrome, repeated(UPLOAD_BLOCK))), BrowserTarget.Chrome);
    assertEveryStepPassed(result, UPLOAD_BLOCK.length);
  });

  test(`a tab that crashes mid-plan is reported as target-crashed and cleaned up in all ${REPETITIONS} runs`, async () => {
    const plan = capability.plan(capabilityPlan(BrowserTarget.Chrome, CRASH_PLAN_STEPS));
    for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
      const watched = watchedDriver(capabilityCdpDriver(BROWSERS.chrome));
      const drivers = new Map([...capabilityDrivers(), ['cdp', watched.driver]]);
      const crashed = crashWhenRequested(capability, watched, CRASH_READY_PATH);
      const { result, store } = await capability.run(plan, BrowserTarget.Chrome, { drivers });
      const endedRenderers = await crashed;
      const context = `repetition ${repetition}`;
      assert.ok(endedRenderers > 0, `${context}: the test found a renderer to end`);
      assert.deepEqual(result.steps.map((step) => [step.index, step.outcome, step.code]), [
        [0, 'passed', undefined], [1, 'failed', 'target-crashed'], [2, 'skipped', undefined], [3, 'skipped', undefined],
      ], context);
      assert.equal(result.state, 'Failed', context);
      assert.deepEqual(store.references(), [], `${context}: nothing was captured after the crash`);
      const session = watched.sessions[0];
      assert.ok(session !== undefined && session.closeCalls === 1, `${context}: the run closed the session once`);
      assert.equal(session.closeError, null, `${context}: close() did not fail`);
      assert.deepEqual(session.stillRunningAfterClose, [], `${context}: every browser process exited`);
    }
  });
});

describe('what each capability does', () => {
  test('a frame step acts on the iframe document, not on the same-named control outside it', async () => {
    const { result } = await capability.run(capability.plan(capabilityPlan(BrowserTarget.Chrome, FRAME_BLOCK)), BrowserTarget.Chrome);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('counter-example: the frame\'s status is not found from the outer document', async () => {
    const plan = capability.plan(capabilityPlan(BrowserTarget.Chrome, [
      navigate('/frame.html'),
      { type: 'expect', locator: testId('frame-status'), assert: { kind: 'visible' }, criterionId: 'frame.status-outside' },
    ]));
    const { result } = await capability.run(plan, BrowserTarget.Chrome);
    assert.equal(result.state, 'Failed');
    assert.equal(result.steps[1]?.outcome, 'failed');
  });

  test('a failing check inside a frame fails the frame step', async () => {
    const plan = capability.plan(capabilityPlan(BrowserTarget.Chrome, [
      navigate('/frame.html'),
      { type: 'frame', locator: testId('checkout-frame'), steps: [textEquals(testId('frame-status'), 'Confirmed for nobody', 'frame.wrong-text')] },
      textEquals(testId('outer-status'), 'Not confirmed', 'frame.outer-untouched'),
    ]));
    const { result } = await capability.run(plan, BrowserTarget.Chrome);
    assert.equal(result.state, 'Failed');
    assert.equal(result.steps[1]?.outcome, 'failed');
    assert.equal(result.steps[2]?.outcome, 'skipped');
  });

  test('a dialog whose text is not the expected text fails the dialog step and skips the rest', async () => {
    const plan = capability.plan(capabilityPlan(BrowserTarget.Chrome, [
      navigate('/dialog.html'),
      click(role('button', 'Ask a question')),
      { type: 'dialog', action: 'accept', expectText: 'Keep every draft?' },
      textEquals(testId('dialog-status'), 'Kept', 'dialog.accepted'),
    ]));
    const { result } = await capability.run(plan, BrowserTarget.Chrome);
    assert.equal(result.state, 'Failed');
    assert.deepEqual(result.steps.map((step) => step.outcome), ['passed', 'passed', 'failed', 'skipped']);
  });

  test('the uploaded file reaches the page with its declared name and its bytes', async () => {
    const { result } = await capability.run(capability.plan(capabilityPlan(BrowserTarget.Chrome, UPLOAD_BLOCK)), BrowserTarget.Chrome);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });
});
