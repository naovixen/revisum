// Which driver performs the page checks, downloads and second tab of plan language 1.2. The own
// CDP driver performs them all, so the same plans pass there. The Playwright fallback performs
// none: a run with any of them fails that step with unsupported-step, never a partial result,
// and skips the rest. Nothing of the step reaches the page: no input event is counted, no file
// is fetched, no tab's page is requested and a page to load with scripts off is never loaded.
// Each refusal is paired with the same plan without the feature, which the fallback does run.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGET, PLAYWRIGHT_TARGET, canonicalUrl, click, download, expectState, hrefEquals, metaContent, navigate, navigateWithoutScripts,
  newTab, outcomes, pageStatesHarness, role, testId, textEquals, type JsonRecord, type PageStatesHarness,
} from './page-states-support.ts';

let harness: PageStatesHarness;
before(async () => { harness = await pageStatesHarness(); });
after(async () => { await harness.close(); });

type Feature = {
  readonly name: string;
  readonly page: string;
  readonly withFeature: () => JsonRecord;
  readonly without: JsonRecord;
  // A path the step would make the browser request, which a refused step must never request.
  readonly neverRequested?: () => string;
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
    neverRequested: () => harness.files.projects.path,
  },
  {
    name: 'a newTab', page: '/index.html',
    withFeature: () => newTab('/account', [textEquals(testId('session-cookie'), 'Signed out', 'support.tab-signed-out')]),
    without: continueShown(),
    neverRequested: () => '/account',
  },
];

// Open the page, use the feature, then send input and check the page.
const stepsWith = (page: string, step: JsonRecord) => [navigate(page), step, click(role('button', 'Continue')), continueShown()];

describe(`the Playwright fallback: ${PLAYWRIGHT_TARGET}`, () => {
  for (const feature of FEATURES) {
    test(`a run with ${feature.name} fails that step with unsupported-step, sends nothing and skips the rest`, { criterion: 'AC-SPEC-31-15' }, async () => {
      const { result, atClose, requestedPaths } = await harness.runSteps(PLAYWRIGHT_TARGET, stepsWith(feature.page, feature.withFeature()));
      assert.equal(result.state, 'Failed');
      assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
      assert.equal(atClose?.shown['input-events'], '0', 'no input event reached the page');
      if (feature.neverRequested !== undefined) assert.ok(!requestedPaths.includes(feature.neverRequested()), `${feature.neverRequested()} was never requested`);
    });

    test(`counter-example: the same run without ${feature.name} passes and sends its input`, { criterion: 'AC-SPEC-31-15' }, async () => {
      const { result, atClose } = await harness.runSteps(PLAYWRIGHT_TARGET, stepsWith(feature.page, feature.without));
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.notEqual(atClose?.shown['input-events'], '0');
    });
  }

  test('a run with a navigate whose scripts are disabled fails it with unsupported-step and never loads the page', { criterion: 'AC-SPEC-31-15' }, async () => {
    const { result, requestedPaths } = await harness.runSteps(PLAYWRIGHT_TARGET, [
      navigate('/index.html'), navigateWithoutScripts('/head.html'), click(role('button', 'Continue')), continueShown(),
    ]);
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
    assert.ok(!requestedPaths.includes('/head.html'), 'the page was never loaded, with scripts or without');
  });

  test('counter-example: the same navigate without scripts disabled loads the page', { criterion: 'AC-SPEC-31-15' }, async () => {
    const { result, requestedPaths } = await harness.runSteps(PLAYWRIGHT_TARGET, [
      navigate('/index.html'), navigate('/head.html'), click(role('button', 'Continue')), continueShown(),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.ok(requestedPaths.includes('/head.html'));
  });
});

describe(`the own CDP driver: ${CDP_TARGET}`, () => {
  for (const feature of FEATURES) {
    test(`a run with ${feature.name} performs it and passes`, { criterion: 'AC-SPEC-31-15' }, async () => {
      const { result } = await harness.runSteps(CDP_TARGET, stepsWith(feature.page, feature.withFeature()));
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    });
  }

  test('a run with a navigate whose scripts are disabled performs it and passes', { criterion: 'AC-SPEC-31-15' }, async () => {
    const { result, requestedPaths } = await harness.runSteps(CDP_TARGET, [
      navigate('/index.html'), navigateWithoutScripts('/head.html'), click(role('button', 'Continue')), continueShown(),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.ok(requestedPaths.includes('/head.html'));
  });
});
