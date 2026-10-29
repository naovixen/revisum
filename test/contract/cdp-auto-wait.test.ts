// Auto-wait on the own CDP driver. A button that is added late, hidden, moving, disabled or
// covered by another element for its first 400 ms gets exactly one click, after it has become
// actionable, and no click lands anywhere else. A button that never becomes actionable fails the
// click with not-actionable within the step timeout plus 1,500 ms, and gets no click.
// Each case is its own fixture page (fixtures/capability-app/auto-wait-<case>.html) whose result
// line counts the clicks; one browser serves every case of a target, with a fresh page load each.
// See docs/specs/SPEC-06-cdp-driver.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { DriverSession } from '@revisum/driver-cdp';
import {
  CDP_TARGETS, capabilityHarness, click, role, shownText, type CapabilityHarness,
} from '../support/capability-harness.ts';

const STEP_TIMEOUT_MILLISECONDS = 2000;
const NEVER_ACTIONABLE_ALLOWANCE_MILLISECONDS = 1500;
const LANDED_ONCE = 'clicks=1 early=0 stray=0 overlay=0';
const NOTHING_LANDED = 'clicks=0 early=0 stray=0 overlay=0';

// Each page, and how its button is not actionable for its first 400 ms.
const ACTIONABLE_AFTER_400_MILLISECONDS = [
  ['late', 'missing from the page'], ['hidden', 'hidden'], ['moving', 'moving'], ['disabled', 'disabled'], ['covered', 'covered by another element'],
] as const;
const NEVER_ACTIONABLE = ['never', 'never-covered'] as const;

let capability: CapabilityHarness;
before(async () => { capability = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS); });
after(async () => { await capability.close(); });

for (const targetId of CDP_TARGETS) {
  describe(`auto-wait: ${targetId}`, () => {
    let session: DriverSession;
    before(async () => { session = await capability.openOwn(targetId); });
    after(async () => { await session.close(); });

    const clickContinue = async (scenario: string) => {
      assert.ok((await session.navigate(capability.url(`/auto-wait-${scenario}.html`))).ok, `the ${scenario} page loads`);
      const started = Date.now();
      const acted = await session.act(capability.actionStep(click(role('button', 'Continue'))));
      return { acted, elapsed: Date.now() - started, shown: await shownText(capability, session, 'result') };
    };

    for (const [scenario, description] of ACTIONABLE_AFTER_400_MILLISECONDS) {
      test(`a button ${description} for its first 400 ms gets one click, after it is ready`, { criterion: 'AC-SPEC-06-03' }, async () => {
        const { acted, shown } = await clickContinue(scenario);
        assert.ok(acted.ok, acted.ok ? '' : `${acted.error.code}: ${acted.error.detail}`);
        assert.equal(shown, LANDED_ONCE);
      });
    }

    for (const scenario of NEVER_ACTIONABLE) {
      test(`a button that is ${scenario === 'never' ? 'never enabled' : 'always covered'} fails with not-actionable within the timeout plus 1,500 ms`, { criterion: 'AC-SPEC-06-03' }, async () => {
        const { acted, elapsed, shown } = await clickContinue(scenario);
        assert.equal(acted.ok ? 'passed' : acted.error.code, 'not-actionable');
        assert.ok(elapsed <= STEP_TIMEOUT_MILLISECONDS + NEVER_ACTIONABLE_ALLOWANCE_MILLISECONDS, `took ${elapsed} ms`);
        assert.equal(shown, NOTHING_LANDED);
      });
    }

    // Counter-example: the result line does count a click that lands too early, so the checks
    // above can fail. A page script clicks the button while it is still moving.
    test('counter-example: a click while the button still moves is counted as early', { criterion: 'AC-SPEC-06-03' }, async () => {
      assert.ok((await session.navigate(capability.url('/auto-wait-moving.html'))).ok);
      const early = await session.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Continue');
        button?.click();
        return document.querySelector('[data-testid="result"]')?.textContent ?? '';
      });
      assert.equal(early, 'clicks=1 early=1 stray=0 overlay=0');
    });
  });
}
