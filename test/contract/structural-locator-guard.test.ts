// The runtime guard judges every element a CSS or XPath locator resolves for an action, as it
// judges any other, in a real browser on both drivers (fixtures/unsafe-features-app/guard.html):
//   - a button named "Delete account", found by its class, its place in the page, or by hasText
//     inside a section, ends the run Denied with irreversible-action, and the page receives no
//     input event at all (the page counts every press, click, key and value change);
//   - a control with no accessible name ends the run Denied with unnamed-control, unless the exact
//     selector that found it is listed in the project's unnamedControlsAllowed. A selector that
//     finds the same control but is not the listed text is denied.
// A selector or expression the browser rejects fails its step with selector-invalid, with nothing
// sent. Each deny is paired with an allowed click found the same way, whose input does reach the
// page, so the counter is shown able to move.
// The engine-level half, the guard's verdicts on resolved elements, is in
// test/unit/engine/policy-unsafe-features.test.ts.
// See docs/specs/SPEC-36-unsafe-plan-features.md and docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  ADAPTER_OF, ALLOWED_UNNAMED_SELECTOR, BOTH_TARGETS, click, css, listedFeatures, navigate, outcomes, testId, textEquals, unsafePageDrivers,
  unsafePageHarness, xpath,
  type JsonRecord, type UnsafePageHarness, type UnsafePageRun,
} from './unsafe-page-support.ts';

let harness: UnsafePageHarness;
before(async () => { harness = await unsafePageHarness(); });
after(async () => { await harness.close(); });

const STATES = ['input-events', 'account-state', 'details-state', 'toolbar-state'];

// Opens the guard page and clicks `locator`, then checks a state the click would change. Nothing
// before the click sends input, so a denied click leaves the input counter at 0.
const clickOnGuardPage = (targetId: string, locator: JsonRecord, followUp: JsonRecord): Promise<UnsafePageRun> =>
  harness.runSteps(targetId, [navigate('/guard.html'), click(locator), followUp], { read: STATES });

const accountKept = (): JsonRecord => textEquals(testId('account-state'), 'Account kept', 'guard.account-kept');

function assertDenied(ran: UnsafePageRun, rule: string): void {
  assert.equal(ran.result.state, 'Denied', JSON.stringify(ran.result.steps));
  assert.deepEqual(ran.result.denial, { rule, stepIndex: 1 });
  assert.equal(ran.result.steps[1]?.code, 'policy-denied');
  assert.equal(ran.atClose?.shown['input-events'], '0', 'no input event reached the page');
}

function assertClickReachedPage(ran: UnsafePageRun): void {
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.notEqual(ran.atClose?.shown['input-events'], '0', 'the click reached the page');
}

// Every way of finding the "Delete account" button by page structure. `alsoNeeds` names a feature
// from before this spec the locator needs too, such as positions, which the Playwright fallback does
// not declare; on a driver without it the locator is left out.
const DELETE_ACCOUNT_LOCATORS: readonly { readonly name: string; readonly locator: JsonRecord; readonly alsoNeeds?: string }[] = [
  { name: 'the CSS selector button.danger', locator: css('button.danger') },
  { name: 'an XPath expression by its place in the page', locator: xpath('//main/section[1]/button[1]') },
  { name: 'a CSS selector with hasText inside another CSS locator', locator: css('button', { hasText: 'Delete account', inside: css('section.account') }) },
  { name: 'a CSS selector with a position', locator: css('section.account button', { position: 'first' }), alsoNeeds: 'positions' },
];

for (const targetId of BOTH_TARGETS) {
  const declaredBefore = listedFeatures(unsafePageDrivers().get(ADAPTER_OF[targetId] ?? ''));
  const locators = DELETE_ACCOUNT_LOCATORS.filter((entry) => entry.alsoNeeds === undefined || declaredBefore.includes(entry.alsoNeeds));

  describe(`irreversible actions found by structure: ${targetId}`, () => {
    for (const { name, locator } of locators) {
      test(`a click on "Delete account" found by ${name} is denied irreversible-action with zero input events`, { criterion: 'AC-SPEC-36-06' }, async () => {
        const ran = await clickOnGuardPage(targetId, locator, accountKept());
        assertDenied(ran, 'irreversible-action');
        assert.equal(ran.atClose?.shown['account-state'], 'Account kept');
      });
    }

    // Counter-examples: the same kinds of locator finding a harmless button do click it.
    test('counter-example: button.safe, named "Show details", is clicked and the page shows it', { criterion: 'AC-SPEC-36-06' }, async () => {
      const ran = await clickOnGuardPage(targetId, css('button.safe'), textEquals(testId('details-state'), 'Details shown', 'guard.details-shown'));
      assertClickReachedPage(ran);
    });

    test('counter-example: the XPath expression for the second button of the section clicks "Show details"', { criterion: 'AC-SPEC-36-06' }, async () => {
      const ran = await clickOnGuardPage(targetId, xpath('//main/section[1]/button[2]'), textEquals(testId('details-state'), 'Details shown', 'guard.details-shown'));
      assertClickReachedPage(ran);
    });
  });

  describe(`unnamed controls found by structure: ${targetId}`, () => {
    test('an icon button with no accessible name found by an unlisted CSS selector is denied unnamed-control with zero input events', { criterion: 'AC-SPEC-36-06' }, async () => {
      const ran = await clickOnGuardPage(targetId, css('button.icon-menu'), textEquals(testId('toolbar-state'), 'Toolbar untouched', 'guard.toolbar-untouched'));
      assertDenied(ran, 'unnamed-control');
      assert.equal(ran.atClose?.shown['toolbar-state'], 'Toolbar untouched');
    });

    test('an icon button with no accessible name found by an unlisted XPath expression is denied unnamed-control', { criterion: 'AC-SPEC-36-06' }, async () => {
      const ran = await clickOnGuardPage(targetId, xpath('//main/section[2]/button[2]'), textEquals(testId('toolbar-state'), 'Toolbar untouched', 'guard.toolbar-untouched'));
      assertDenied(ran, 'unnamed-control');
    });

    test(`the unnamed icon button found by the exact listed selector ${ALLOWED_UNNAMED_SELECTOR} is clicked`, { criterion: 'AC-SPEC-36-06' }, async () => {
      const ran = await clickOnGuardPage(targetId, css(ALLOWED_UNNAMED_SELECTOR), textEquals(testId('toolbar-state'), 'Toolbar closed', 'guard.toolbar-closed'));
      assertClickReachedPage(ran);
    });

    // Mutant of the allow-list: the same control, found by a selector that holds the listed one but
    // is not it, is denied, so the list is matched exactly and not by what the selector resolves.
    test('the same unnamed button found by a selector that only contains the listed one is denied unnamed-control', { criterion: 'AC-SPEC-36-06' }, async () => {
      const ran = await clickOnGuardPage(targetId, css(`section.toolbar ${ALLOWED_UNNAMED_SELECTOR}`), textEquals(testId('toolbar-state'), 'Toolbar untouched', 'guard.toolbar-untouched'));
      assertDenied(ran, 'unnamed-control');
      assert.equal(ran.atClose?.shown['toolbar-state'], 'Toolbar untouched');
    });
  });

  describe(`selectors the browser rejects: ${targetId}`, () => {
    for (const { name, locator } of [
      { name: 'a CSS selector', locator: css('button[') },
      { name: 'an XPath expression', locator: xpath('//button[') },
    ]) {
      test(`a click found by ${name} the browser rejects fails with selector-invalid, sends nothing and skips the rest`, { criterion: 'AC-SPEC-36-06' }, async () => {
        const ran = await clickOnGuardPage(targetId, locator, accountKept());
        assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'selector-invalid'], [2, 'skipped', undefined]], JSON.stringify(ran.result.steps));
        assert.equal(ran.atClose?.shown['input-events'], '0', 'no input event reached the page');
      });
    }
  });
}
