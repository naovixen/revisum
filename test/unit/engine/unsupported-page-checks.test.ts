// Until the CDP driver reads them, runs report the page checks, downloads and second tab of plan
// language 1.2 as failed with unsupported-step: the new state checks, the link-target check, the
// meta tag and canonical URL checks, a navigate with scripts disabled, a download and a newTab.
// The step never gives a partial result: no probe, action or navigation of it reaches the driver,
// and every later step is skipped. Each counter-example runs the same plan with the 1.1 form of
// the step and does reach the driver.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPEN_ORDERS, ORIGIN, PAGE_TITLE, label, navigate, planOf, runPlan, type JsonRecord } from './run-value-examples.ts';

const AFTER: JsonRecord = { type: 'click', locator: { by: 'role', role: 'button', name: 'Continue' } };
const TAB: JsonRecord = { by: 'role', role: 'tab', name: 'Billing' };
const LINK: JsonRecord = { by: 'role', role: 'link', name: 'Billing guide' };
const expectOn = (locator: JsonRecord, assertion: JsonRecord): JsonRecord =>
  ({ type: 'expect', locator, assert: assertion, criterionId: 'settings.billing-shown' });
const expectPage = (assertion: JsonRecord): JsonRecord => ({ type: 'expectPage', assert: assertion, criterionId: 'settings.page-shown' });

type Feature = { readonly name: string; readonly withFeature: JsonRecord; readonly without: JsonRecord };

const FEATURES: readonly Feature[] = [
  ...['selected', 'unselected', 'expanded', 'collapsed', 'pressed', 'unpressed', 'current'].map((kind): Feature => ({
    name: `the state check "${kind}"`, withFeature: expectOn(TAB, { kind }), without: expectOn(TAB, { kind: 'visible' }),
  })),
  {
    name: 'a link-target check',
    withFeature: expectOn(LINK, { kind: 'hrefEquals', value: `${ORIGIN}/help/billing` }),
    without: expectOn(LINK, { kind: 'visible' }),
  },
  {
    name: 'a meta tag check',
    withFeature: expectPage({ kind: 'metaContent', name: 'og:title', value: PAGE_TITLE }),
    without: expectPage({ kind: 'title', value: PAGE_TITLE }),
  },
  {
    name: 'a canonical URL check',
    withFeature: expectPage({ kind: 'canonicalUrl', value: `${ORIGIN}/orders` }),
    without: expectPage({ kind: 'urlPath', value: '/orders' }),
  },
];

// What the driver was asked, other than opening the session.
const reached = (recording: { readonly navigations: readonly string[]; readonly actions: readonly unknown[]; readonly probes: number }) =>
  ({ navigations: recording.navigations, actions: recording.actions.length, probes: recording.probes });

for (const feature of FEATURES) {
  test(`a run with ${feature.name} fails that step with unsupported-step, reads nothing and skips the rest`, { criterion: 'AC-SPEC-31-15' }, async () => {
    const { result, recording } = await runPlan(planOf([OPEN_ORDERS, feature.withFeature, AFTER]));
    assert.equal(result.state, 'Failed');
    assert.deepEqual(result.steps.map((step) => [step.index, step.outcome, step.code]), [
      [0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined],
    ]);
    assert.deepEqual(reached(recording), { navigations: [`${ORIGIN}/orders`], actions: 0, probes: 0 }, 'only the first navigation reached the driver');
  });

  test(`counter-example: the same run with the 1.1 form of ${feature.name} checks the page and passes`, { criterion: 'AC-SPEC-31-15' }, async () => {
    const { result, recording } = await runPlan(planOf([OPEN_ORDERS, feature.without, AFTER]));
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.equal(recording.actions.length, 1, 'the click after the check reached the driver');
  });
}

test('a run with a navigate whose scripts are disabled fails it with unsupported-step and never loads the page with scripts on', { criterion: 'AC-SPEC-31-15' }, async () => {
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, { ...navigate('/events/team-meeting'), scripts: 'disabled' }, AFTER]));
  assert.equal(result.state, 'Failed');
  assert.deepEqual(result.steps.map((step) => [step.index, step.outcome, step.code]), [
    [0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined],
  ]);
  assert.deepEqual(reached(recording), { navigations: [`${ORIGIN}/orders`], actions: 0, probes: 0 });
});

test('counter-example: the same navigate without scripts disabled loads the page', { criterion: 'AC-SPEC-31-15' }, async () => {
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, navigate('/events/team-meeting'), AFTER]));
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  assert.deepEqual(recording.navigations, [`${ORIGIN}/orders`, `${ORIGIN}/events/team-meeting`]);
});

const EXPORT_BUTTON: JsonRecord = { by: 'role', role: 'button', name: 'Export CSV' };
const DOWNLOAD: JsonRecord = { type: 'download', name: 'project-list', locator: EXPORT_BUTTON };
const CHECK_DOWNLOAD: JsonRecord = {
  type: 'expectDownload', download: 'project-list', assert: { kind: 'sizeAtLeast', value: 1 }, criterionId: 'projects.export-not-empty',
};

test('a run with a download fails it with unsupported-step, clicks nothing and skips its checks', { criterion: 'AC-SPEC-31-15' }, async () => {
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, DOWNLOAD, CHECK_DOWNLOAD]));
  assert.equal(result.state, 'Failed');
  assert.deepEqual(result.steps.map((step) => [step.index, step.type, step.outcome, step.code]), [
    [0, 'navigate', 'passed', undefined], [1, 'download', 'failed', 'unsupported-step'],
    [2, 'expectDownload', 'skipped', undefined], [3, 'expect', 'skipped', undefined],
  ]);
  assert.deepEqual(reached(recording), { navigations: [`${ORIGIN}/orders`], actions: 0, probes: 0 }, 'the export button was never clicked');
});

test('counter-example: a click on the same button reaches the driver', { criterion: 'AC-SPEC-31-15' }, async () => {
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, { type: 'click', locator: EXPORT_BUTTON }]));
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  assert.deepEqual(recording.actions.map((action) => action.type), ['click']);
});

const TAB_STEPS: readonly JsonRecord[] = [
  { type: 'fill', locator: label('Search'), value: 'Website relaunch' },
  expectOn({ by: 'role', role: 'heading', name: 'Your account' }, { kind: 'visible' }),
];

test('a run with a newTab fails it with unsupported-step, opens nothing and runs none of its steps', { criterion: 'AC-SPEC-31-15' }, async () => {
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, { type: 'newTab', url: '/account', steps: TAB_STEPS }, AFTER]));
  assert.equal(result.state, 'Failed');
  assert.deepEqual(result.steps.filter((step) => step.outcome !== 'skipped').map((step) => [step.index, step.type, step.outcome, step.code]), [
    [0, 'navigate', 'passed', undefined], [1, 'newTab', 'failed', 'unsupported-step'],
  ]);
  assert.ok(result.steps.some((step) => step.index === 2 && step.outcome === 'skipped'), JSON.stringify(result.steps));
  assert.deepEqual(reached(recording), { navigations: [`${ORIGIN}/orders`], actions: 0, probes: 0 }, 'nothing of the tab reached the driver');
  assert.equal(recording.environments.length, 1, 'only the one session was opened');
});

test('counter-example: the same steps in the first tab reach the driver', { criterion: 'AC-SPEC-31-15' }, async () => {
  const { result, recording } = await runPlan(planOf([OPEN_ORDERS, navigate('/account'), ...TAB_STEPS, AFTER]));
  assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  assert.deepEqual(recording.navigations, [`${ORIGIN}/orders`, `${ORIGIN}/account`]);
  assert.deepEqual(recording.actions.map((action) => action.type), ['fill', 'click']);
});

