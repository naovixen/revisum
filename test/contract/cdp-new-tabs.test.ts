// A second tab in a real browser, on the own CDP driver. A plan signs in on the fixture app
// (fixtures/page-states-app/sign-in.html): the server sets an HttpOnly session cookie and the
// signed-in page keeps a name in local storage. A newTab block then opens /account, which the
// server renders "Signed in" only when the browser sent that cookie, and whose script shows the
// stored name and its own clock. The same pages count the other open pages of their origin over a
// broadcast channel ("Count other tabs"), so a test sees whether the tab is still open.
// The tab shares the session's cookies and storage, keeps the frozen clock, and is closed when
// its block ends, even when a step inside it fails. The /account page asks an origin no project
// allows for an image; that blocked origin joins the run's blockedOrigins.
// A popup the page opens inside the tab still fails its step with unsupported-step.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Session } from '@revisum/engine';
import {
  CDP_TARGET, CLOCK_START_MILLISECONDS, click, fill, label, navigate, newTab, outcomes, pageStatesHarness, role, settledText, testId,
  textEquals, type PageStatesHarness,
} from './page-states-support.ts';

let harness: PageStatesHarness;
before(async () => { harness = await pageStatesHarness(); });
after(async () => { await harness.close(); });

const BLOCKED_IN_TAB = 'https://tab-tracker.example';
const SIGN_IN = [
  navigate('/sign-in.html'),
  fill(label('Name'), 'Ada'),
  click(role('button', 'Sign in')),
  textEquals(testId('sign-in-status'), 'Signed in', 'tabs.signed-in'),
];
const COUNT_TABS = click(role('button', 'Count other tabs'));
const otherTabs = (count: string, criterionId: string) => textEquals(testId('other-tabs'), count, criterionId);

describe('a newTab after signing in', () => {
  test('the tab sends the session cookie, reads the stored name and the frozen clock, sees the first tab, and is closed after its block', { criterion: 'AC-SPEC-31-11' }, async () => {
    const { result, requestedPaths } = await harness.runSteps(CDP_TARGET, [
      ...SIGN_IN,
      newTab('/account', [
        textEquals(testId('session-cookie'), 'Signed in', 'tabs.cookie-shared'),
        textEquals(testId('stored-name'), 'Ada', 'tabs.storage-shared'),
        textEquals(testId('page-now'), String(CLOCK_START_MILLISECONDS), 'tabs.clock-frozen'),
        COUNT_TABS,
        otherTabs('1', 'tabs.first-tab-seen'),
      ]),
      COUNT_TABS,
      otherTabs('0', 'tabs.tab-closed'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.ok(requestedPaths.includes('/account'), 'the tab loaded its page');
  });

  test('the origin the tab\'s page was blocked from joins the run\'s blocked origins', { criterion: 'AC-SPEC-31-11' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      ...SIGN_IN, newTab('/account', [textEquals(testId('session-cookie'), 'Signed in', 'tabs.cookie-shared')]),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.ok(result.blockedOrigins.includes(BLOCKED_IN_TAB), JSON.stringify(result.blockedOrigins));
  });

  // Counter-example: the first tab's pages ask for nothing blocked, so the origin above came
  // from the second tab.
  test('counter-example: the same sign-in without the tab blocks no such origin', { criterion: 'AC-SPEC-31-11' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, SIGN_IN);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.ok(!result.blockedOrigins.includes(BLOCKED_IN_TAB), JSON.stringify(result.blockedOrigins));
  });

  // Counter-example: without signing in, the same tab shows no session and no stored name, so the
  // checks above see what signing in shared.
  test('counter-example: a tab opened without signing in shows "Signed out" and no stored name', { criterion: 'AC-SPEC-31-11' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      navigate('/sign-in.html'),
      newTab('/account', [
        textEquals(testId('session-cookie'), 'Signed out', 'tabs.no-cookie'),
        textEquals(testId('stored-name'), 'none', 'tabs.no-storage'),
      ]),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });
});

describe('a newTab whose step fails', () => {
  test('fails the newTab step with that step\'s code, skips the rest, and still closes the tab', { criterion: 'AC-SPEC-31-11' }, async () => {
    const counted: { shown: string | null } = { shown: null };
    // Asks the first tab, as the session closes, how many other pages of the origin answer.
    const countAtClose = async (session: Session): Promise<void> => {
      const acted = await session.act(harness.actionStep(COUNT_TABS));
      assert.ok(acted.ok, `the count could be asked: ${acted.ok ? '' : acted.error.code}`);
      counted.shown = await settledText(harness, session, 'other-tabs', 'counting');
    };
    const { result } = await harness.runSteps(CDP_TARGET, [
      ...SIGN_IN,
      newTab('/account', [textEquals(testId('session-cookie'), 'Signed in as someone else', 'tabs.wrong-person'), COUNT_TABS]),
      COUNT_TABS,
      otherTabs('0', 'tabs.tab-closed'),
    ], { beforeClose: countAtClose });
    assert.equal(result.state, 'Failed');
    assert.deepEqual(outcomes(result), [
      [0, 'passed', undefined], [1, 'passed', undefined], [2, 'passed', undefined], [3, 'passed', undefined],
      [4, 'failed', 'assertion-failed'], [5, 'skipped', undefined], [6, 'skipped', undefined],
    ]);
    assert.equal(counted.shown, '0', 'no other page of the origin is open');
    assert.ok(result.blockedOrigins.includes(BLOCKED_IN_TAB), 'the failed tab\'s blocked origins still joined the run\'s');
  });
});

describe('a popup opened inside a newTab', () => {
  test('fails the newTab step with unsupported-step and skips the rest', { criterion: 'AC-SPEC-31-09' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      navigate('/sign-in.html'),
      newTab('/account', [click(role('button', 'Open help')), textEquals(testId('stored-name'), 'none', 'tabs.no-storage')]),
      textEquals(testId('other-tabs'), 'not counted', 'tabs.first-tab-shown'),
    ]);
    assert.equal(result.state, 'Failed');
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined]]);
  });
});
