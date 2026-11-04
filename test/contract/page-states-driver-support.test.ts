// The own CDP driver performs the page checks, downloads and second tab of the plan language, and the
// same plans run with the plainer form of each step.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { click, navigate, newTab, role, testId, textEquals, type JsonRecord } from '#test-support/browser/RawPlan.ts';
import { canonicalUrl, download, expectState, hrefEquals, metaContent, navigateWithoutScripts, pageStatesHarness, type PageStatesHarness } from './page-states-support.ts';

let harness: PageStatesHarness;
before(async () => { harness = await pageStatesHarness(); });
after(async () => { await harness.close(); });

type Feature = {
  readonly name: string;
  readonly page: string;
  readonly withFeature: () => JsonRecord;
  readonly without: JsonRecord;
};

const pageTitle = (value: string): JsonRecord => ({ type: 'expectPage', assert: { kind: 'title', value }, criterionId: 'support.title-shown' });
const continueShown = (): JsonRecord => expectState(role('button', 'Continue'), 'visible', 'support.continue-shown');

const FEATURES: readonly Feature[] = [
  {
    name: 'a state check', page: '/states.html',
    withFeature: () => expectState(role('tab', 'Profile'), 'selected', 'support.tab-selected'),
    without: expectState(role('tab', 'Profile'), 'visible', 'support.tab-shown'),
  },
  {
    name: 'a link-target check', page: '/links.html',
    withFeature: () => hrefEquals(role('link', 'Guide'), '/guide.html', 'support.guide-target'),
    without: expectState(role('link', 'Guide'), 'visible', 'support.guide-shown'),
  },
  {
    name: 'a meta tag check', page: '/head.html',
    withFeature: () => metaContent('description', 'Garden tools at half price.', 'support.description'),
    without: pageTitle('Spring sale'),
  },
  {
    name: 'a canonical URL check', page: '/head.html',
    withFeature: () => canonicalUrl(`${harness.origin}/head.html?view=canonical`, 'support.canonical'),
    without: pageTitle('Spring sale'),
  },
  {
    name: 'a download', page: '/downloads.html',
    withFeature: () => download('project-list', role('link', 'Export CSV')),
    without: expectState(role('link', 'Export CSV'), 'visible', 'support.export-shown'),
  },
  {
    name: 'a newTab', page: '/index.html',
    withFeature: () => newTab('/account', [textEquals(testId('session-cookie'), 'Signed out', 'support.tab-signed-out')]),
    without: continueShown(),
  },
];

// Open the page, use the feature, then send input and check the page.
const stepsWith = (page: string, step: JsonRecord) => [navigate(page), step, click(role('button', 'Continue')), continueShown()];

describe(`the own CDP driver: ${BrowserTarget.Chrome}`, () => {
  for (const feature of FEATURES) {
    test(`counter-example: a run without ${feature.name} passes and sends its input`, async () => {
      const { result, atClose } = await harness.runSteps(BrowserTarget.Chrome, stepsWith(feature.page, feature.without));
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.notEqual(atClose?.shown['input-events'], '0');
    });
  }

  test('counter-example: a navigate without scripts disabled loads the page', async () => {
    const { result, requestedPaths } = await harness.runSteps(BrowserTarget.Chrome, [
      navigate('/index.html'), navigate('/head.html'), click(role('button', 'Continue')), continueShown(),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.ok(requestedPaths.includes('/head.html'));
  });

  for (const feature of FEATURES) {
    test(`a run with ${feature.name} performs it and passes`, async () => {
      const { result } = await harness.runSteps(BrowserTarget.Chrome, stepsWith(feature.page, feature.withFeature()));
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    });
  }

  test('a run with a navigate whose scripts are disabled performs it and passes', async () => {
    const { result, requestedPaths } = await harness.runSteps(BrowserTarget.Chrome, [
      navigate('/index.html'), navigateWithoutScripts('/head.html'), click(role('button', 'Continue')), continueShown(),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.ok(requestedPaths.includes('/head.html'));
  });
});
