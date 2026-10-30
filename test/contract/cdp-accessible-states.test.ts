// Accessibility state checks in a real browser, on the own CDP driver. The fixture page
// (fixtures/page-states-app/states.html) holds an ARIA tab list, disclosure buttons, toggle
// buttons, a navigation with aria-current, a native select and native details. Each state check
// passes on an element in that state, and its opposite fails there with assertion-failed.
// An element that does not expose the property, including one whose state is shown only by a CSS
// class, fails every check of that property with state-not-exposed: never a pass, whichever of the
// pair is asked. The counter-example shows an element that exposes the property fails the wrong
// state with assertion-failed instead, so the two codes are told apart.
// The runs share one browser; each starts by loading the page again.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { BrowserDriver } from '@revisum/engine';
import {
  CDP_TARGET, click, expectState, navigate, outcomes, pageStatesHarness, reusedSessionDriver, role, testId,
  type JsonRecord, type PageStatesHarness,
} from './page-states-support.ts';

let harness: PageStatesHarness;
let closeShared: () => Promise<void>;
let drivers: ReadonlyMap<string, BrowserDriver>;
before(async () => {
  harness = await pageStatesHarness();
  const inner = harness.drivers.get('cdp');
  assert.ok(inner !== undefined);
  const reused = reusedSessionDriver(inner);
  drivers = new Map([...harness.drivers, ['cdp', reused.driver]]);
  closeShared = () => reused.closeAll();
});
after(async () => {
  await closeShared();
  await harness.close();
});

const OPEN_STATES = navigate('/states.html');
const AFTER_CHECK = click(role('button', 'Continue'));

const runChecks = (steps: readonly unknown[]) => harness.runSteps(CDP_TARGET, [OPEN_STATES, ...steps, AFTER_CHECK], { drivers });

type StateCase = { readonly element: string; readonly locator: JsonRecord; readonly holds: string; readonly opposite: string };

const IN_STATE: readonly StateCase[] = [
  { element: 'the selected tab', locator: role('tab', 'Profile'), holds: 'selected', opposite: 'unselected' },
  { element: 'the tab not selected', locator: role('tab', 'Billing'), holds: 'unselected', opposite: 'selected' },
  { element: 'the open disclosure button', locator: testId('shipping-disclosure'), holds: 'expanded', opposite: 'collapsed' },
  { element: 'the closed disclosure button', locator: testId('returns-disclosure'), holds: 'collapsed', opposite: 'expanded' },
  { element: 'the pressed toggle button', locator: testId('bold-toggle'), holds: 'pressed', opposite: 'unpressed' },
  { element: 'the toggle button not pressed', locator: testId('italic-toggle'), holds: 'unpressed', opposite: 'pressed' },
  { element: 'the selected option of the select', locator: testId('size-large'), holds: 'selected', opposite: 'unselected' },
  { element: 'the option not selected', locator: testId('size-small'), holds: 'unselected', opposite: 'selected' },
  { element: 'the summary of an open details', locator: testId('delivery-summary'), holds: 'expanded', opposite: 'collapsed' },
  { element: 'the summary of a closed details', locator: testId('warranty-summary'), holds: 'collapsed', opposite: 'expanded' },
];

describe('each state check on an element in that state', () => {
  for (const stateCase of IN_STATE) {
    test(`${stateCase.holds} passes on ${stateCase.element}`, { criterion: 'AC-SPEC-31-01' }, async () => {
      const { result } = await runChecks([expectState(stateCase.locator, stateCase.holds, 'states.in-state')]);
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    });

    test(`${stateCase.opposite} fails on ${stateCase.element} with assertion-failed`, { criterion: 'AC-SPEC-31-01' }, async () => {
      const { result } = await runChecks([expectState(stateCase.locator, stateCase.opposite, 'states.opposite')]);
      assert.equal(result.state, 'Failed');
      assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed'], [2, 'skipped', undefined]]);
    });
  }

  test('current passes on the navigation link with aria-current="page"', { criterion: 'AC-SPEC-31-01' }, async () => {
    const { result } = await runChecks([expectState(role('link', 'Overview'), 'current', 'states.current-page')]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('current fails with assertion-failed on the navigation link with aria-current="false"', { criterion: 'AC-SPEC-31-01' }, async () => {
    const { result } = await runChecks([expectState(role('link', 'Reports'), 'current', 'states.not-current')]);
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed'], [2, 'skipped', undefined]]);
  });

  // The state is read from the page as it is now, not as it loaded.
  test('after a click opens the Returns notes disclosure, expanded passes on it', { criterion: 'AC-SPEC-31-01' }, async () => {
    const { result } = await runChecks([click(testId('returns-disclosure')), expectState(testId('returns-disclosure'), 'expanded', 'states.opened')]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('after a click opens the Returns notes disclosure, collapsed fails on it with assertion-failed', { criterion: 'AC-SPEC-31-01' }, async () => {
    const { result } = await runChecks([click(testId('returns-disclosure')), expectState(testId('returns-disclosure'), 'collapsed', 'states.opened')]);
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'passed', undefined], [2, 'failed', 'assertion-failed'], [3, 'skipped', undefined]]);
  });
});

type HiddenStateCase = { readonly element: string; readonly locator: JsonRecord; readonly kinds: readonly string[] };

const NOT_EXPOSED: readonly HiddenStateCase[] = [
  { element: 'a tab shown as selected only by a CSS class', locator: testId('class-only-tab'), kinds: ['selected', 'unselected'] },
  { element: 'a tab shown as not selected only by a missing CSS class', locator: testId('class-only-other-tab'), kinds: ['selected', 'unselected'] },
  { element: 'a button shown as pressed only by a CSS class', locator: testId('class-only-toggle'), kinds: ['pressed', 'unpressed'] },
  { element: 'a button with no aria-expanded', locator: testId('plain-button'), kinds: ['expanded', 'collapsed'] },
  { element: 'a button with no aria-pressed', locator: testId('plain-button'), kinds: ['pressed', 'unpressed'] },
  { element: 'a paragraph of text', locator: testId('plain-text'), kinds: ['selected', 'unselected', 'expanded', 'collapsed', 'pressed', 'unpressed'] },
];

describe('a state check on an element that does not expose the property', () => {
  for (const hidden of NOT_EXPOSED) {
    test(`on ${hidden.element}, ${hidden.kinds.join(', ')} each fail with state-not-exposed and never pass`, { criterion: 'AC-SPEC-31-02' }, async () => {
      for (const kind of hidden.kinds) {
        const { result } = await runChecks([expectState(hidden.locator, kind, 'states.not-exposed')]);
        assert.equal(result.state, 'Failed', `${kind}: ${JSON.stringify(result.steps)}`);
        assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'state-not-exposed'], [2, 'skipped', undefined]], kind);
      }
    });
  }

  // Counter-example: the Italic button exposes aria-pressed="false", so the wrong state fails as
  // an ordinary assertion and the right one passes.
  test('counter-example: on a button that exposes aria-pressed, pressed fails with assertion-failed and unpressed passes', { criterion: 'AC-SPEC-31-02' }, async () => {
    const pressed = await runChecks([expectState(testId('italic-toggle'), 'pressed', 'states.exposed')]);
    assert.deepEqual(outcomes(pressed.result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed'], [2, 'skipped', undefined]]);
    const unpressed = await runChecks([expectState(testId('italic-toggle'), 'unpressed', 'states.exposed')]);
    assert.equal(unpressed.result.state, 'Passed', JSON.stringify(unpressed.result.steps));
  });

  // Counter-example: the class-only tab is on the page and visible, so the refusal is about the
  // state, not about finding the element.
  test('counter-example: the class-only tab is found and visible', { criterion: 'AC-SPEC-31-02' }, async () => {
    const { result } = await runChecks([expectState(testId('class-only-tab'), 'visible', 'states.class-only-shown')]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });
});
