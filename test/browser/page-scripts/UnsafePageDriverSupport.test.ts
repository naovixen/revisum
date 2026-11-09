// The own CDP driver performs the page parts of the plan language: structural locators, DOM checks
// and page scripts. The counters on the page are shown able to move.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { click, navigate, testId, type JsonRecord } from '#test-support/browser/RawPlan.ts';
import { UNSAFE_PAGE_TARGETS, check, css, evaluate, expectScript, rememberAttribute, unsafePageHarness, xpath, type UnsafePageHarness } from './support/UnsafePagePlan.ts';
import { shareBrowserInThisFile } from '#test-support/browser/ShareBrowserInThisFile.ts';

shareBrowserInThisFile();

let harness: UnsafePageHarness;
before(async () => { harness = await unsafePageHarness(); });
after(async () => { await harness.close(); });

type PagePartStep = { readonly name: string; readonly page: string; readonly step: JsonRecord };

// Each passes on the page named.
const PAGE_PART_STEPS: readonly PagePartStep[] = [
  { name: 'a click found by a CSS selector', page: '/guard.html', step: click(css('button.safe')) },
  { name: 'a click found by an XPath expression', page: '/guard.html', step: click(xpath('//main/section[1]/button[2]')) },
  { name: 'a hasClass check', page: '/dom-checks.html', step: check(testId('matching-badge'), { kind: 'hasClass', value: 'is-active' }, 'support.class') },
  {
    name: 'a computedStyleEquals check', page: '/dom-checks.html',
    step: check(testId('matching-badge'), { kind: 'computedStyleEquals', property: 'background-color', value: 'rgb(220, 38, 38)' }, 'support.colour'),
  },
  { name: 'a remember from an attribute', page: '/dom-checks.html', step: rememberAttribute('sortOrder', testId('matching-sort'), 'aria-sort') },
  { name: 'an evaluate of a named script', page: '/', step: evaluate('countRun', {}) },
  // A check needs a read script; hostileResult with a plain result is one.
  {
    name: 'an expectScript on a named script', page: '/',
    step: expectScript('hostileResult', { kind: 'plain', amount: 0 }, 'shape', { kind: 'equals', value: 'plain' }, 'support.script-checked'),
  },
];

const READ = ['input-events', 'script-runs'];
const pageShown = (): JsonRecord => check(testId('input-events'), { kind: 'visible' }, 'support.page-shown');

for (const targetId of UNSAFE_PAGE_TARGETS) {
  describe(`page parts on ${targetId}`, () => {
    for (const { name, page, step } of PAGE_PART_STEPS) {
      test(`${name} passes on the driver as it is`, async () => {
        const ran = await harness.runSteps(targetId, [navigate(page), step, pageShown()]);
        assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
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
