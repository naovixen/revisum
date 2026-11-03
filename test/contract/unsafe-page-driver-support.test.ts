// Which driver performs the page parts of the plan language. The own CDP driver declares
// structuralLocators, domChecks and pageScripts. With one of them taken off a driver's list, and nothing else changed, the run
// refuses every step that needs it with unsupported-step, before anything of it reaches the
// driver: no input event reaches the page, and a script that counts its own runs on the page never
// ran. The same steps on the unchanged driver pass, so the counters are shown able to move.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { outcomes, stepMilliseconds } from '#test-support/browser/BrowserHarness.ts';
import { ADAPTER_OF_TARGET } from '#test-support/browser/BrowserTarget.ts';
import { driversWithout, listedFeatures } from '#test-support/browser/DriversWithout.ts';
import { click, navigate, testId, type JsonRecord } from '#test-support/browser/RawPlan.ts';
import { UNSAFE_PAGE_TARGETS, PAGE_PART_FEATURES, check, css, evaluate, expectScript, rememberAttribute, unsafePageDrivers, unsafePageHarness, xpath, type PagePartFeature, type UnsafePageHarness } from './unsafe-page-support.ts';
import { shareBrowserInThisFile } from '#test-support/browser/ShareBrowserInThisFile.ts';

shareBrowserInThisFile();

let harness: UnsafePageHarness;
before(async () => { harness = await unsafePageHarness(); });
after(async () => { await harness.close(); });

// `alsoNeeds` names a feature from before this spec that the step needs too, such as rememberedValues;
// on a driver without it the step is left out.
type FeatureStep = {
  readonly name: string; readonly feature: PagePartFeature; readonly page: string; readonly step: JsonRecord; readonly alsoNeeds?: string;
};

// One or more steps per feature, each of which passes on the page named, on a driver that declares it.
const FEATURE_STEPS: readonly FeatureStep[] = [
  { name: 'a click found by a CSS selector', feature: 'structuralLocators', page: '/guard.html', step: click(css('button.safe')) },
  { name: 'a click found by an XPath expression', feature: 'structuralLocators', page: '/guard.html', step: click(xpath('//main/section[1]/button[2]')) },
  { name: 'a hasClass check', feature: 'domChecks', page: '/dom-checks.html', step: check(testId('matching-badge'), { kind: 'hasClass', value: 'is-active' }, 'support.class') },
  {
    name: 'a computedStyleEquals check', feature: 'domChecks', page: '/dom-checks.html',
    step: check(testId('matching-badge'), { kind: 'computedStyleEquals', property: 'background-color', value: 'rgb(220, 38, 38)' }, 'support.colour'),
  },
  { name: 'a remember from an attribute', feature: 'domChecks', page: '/dom-checks.html', step: rememberAttribute('sortOrder', testId('matching-sort'), 'aria-sort'), alsoNeeds: 'rememberedValues' },
  { name: 'an evaluate of a named script', feature: 'pageScripts', page: '/', step: evaluate('countRun', {}) },
  // A check needs a read script; hostileResult with a plain result is one.
  {
    name: 'an expectScript on a named script', feature: 'pageScripts', page: '/',
    step: expectScript('hostileResult', { kind: 'plain', amount: 0 }, 'shape', { kind: 'equals', value: 'plain' }, 'support.script-checked'),
  },
];

// Open the page, use the feature, then check the page took no input and no script ran. A step
// refused before it reaches the driver leaves both counters at 0.
const READ = ['input-events', 'script-runs'];
const pageShown = (): JsonRecord => check(testId('input-events'), { kind: 'visible' }, 'support.page-shown');

for (const targetId of UNSAFE_PAGE_TARGETS) {
  const adapter = ADAPTER_OF_TARGET[targetId];
  // The steps this driver can run once it declares this spec's features: each step's other
  // feature, if any, is one the driver declares already.
  const declaredBefore = listedFeatures(unsafePageDrivers().get(adapter));
  const runnable = FEATURE_STEPS.filter((featureStep) => featureStep.alsoNeeds === undefined || declaredBefore.includes(featureStep.alsoNeeds));

  describe(`page parts on ${targetId}`, () => {
    for (const feature of PAGE_PART_FEATURES) {
      test(`the ${adapter} driver declares ${feature}`, () => {
        const listed = listedFeatures(harness.drivers.get(adapter));
        assert.ok(listed.includes(feature), `${adapter} declares ${feature}: ${JSON.stringify(listed)}`);
      });
    }

    for (const { name, page, step } of runnable) {
      test(`${name} passes on the driver as it is`, async () => {
        const ran = await harness.runSteps(targetId, [navigate(page), step, pageShown()]);
        assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
      });
    }

    for (const lacking of PAGE_PART_FEATURES) {
      test(`with ${lacking} taken off its list, the driver is refused that feature's steps with nothing sent, and still runs the others`, { timeout: 300_000 }, async () => {
        const drivers = driversWithout(harness, adapter, lacking);
        for (const { name, feature, page, step } of runnable) {
          const steps = [navigate(page), step, pageShown()];
          const ran = await harness.runSteps(targetId, steps, { drivers, read: READ });
          if (feature !== lacking) {
            assert.equal(ran.result.state, 'Passed', `${name}: ${JSON.stringify(ran.result.steps)}`);
            continue;
          }
          assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined]], `${name}: ${JSON.stringify(ran.result.steps)}`);
          assert.ok(stepMilliseconds(ran.result, 1) < 1000, `${name}: the refused step waited no real time`);
          assert.equal(ran.atClose?.shown['input-events'], '0', `${name}: no input event reached the page`);
          if (page === '/') assert.equal(ran.atClose.shown['script-runs'], '0', `${name}: the script never ran`);
        }
      });
    }

    // Counter-example: the counters move when the steps do run.
    test('counter-example: on the driver as it is, the click reaches the page and the script runs', async () => {
      const clicked = await harness.runSteps(targetId, [navigate('/guard.html'), click(css('button.safe')), pageShown()], { read: READ });
      assert.notEqual(clicked.atClose?.shown['input-events'], '0');
      const scripted = await harness.runSteps(targetId, [navigate('/'), evaluate('countRun', {}), check(testId('script-runs'), { kind: 'textEquals', value: '1' }, 'support.script-ran')], { read: READ });
      assert.equal(scripted.result.state, 'Passed', JSON.stringify(scripted.result.steps));
      assert.equal(scripted.atClose?.shown['script-runs'], '1');
    });
  });
}
