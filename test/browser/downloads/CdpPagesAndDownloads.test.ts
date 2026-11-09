// Popups, second pages and downloads are not part of a run yet. On the own CDP driver a step that
// makes the page open a popup or a second page, or start a download, fails with unsupported-step:
// never a pass, never a partial result. The popup is closed, the download is cancelled and no
// file of it is left behind, and every later step is skipped, so nothing is captured after it.
// A counter-example on the same page shows an ordinary click there passes.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { allowEveryAction } from '#test-support/browser/AllowEveryAction.ts';
import { expectRead } from '#test-support/ExpectRead.ts';
import { onTarget } from '#test-support/TestTier.ts';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { click, navigate, role, testId, textEquals } from '#test-support/browser/RawPlan.ts';
import { capabilityHarness, capabilityPlan, shownText, type CapabilityHarness } from '#test-support/browser/harnesses/CapabilityHarness.ts';
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

let capability: CapabilityHarness;
before(async () => { capability = await capabilityHarness(2000); });
after(async () => { await capability.close(); });

// The files the page's downloads would be saved as.
const DOWNLOAD_NAMES = ['capability-export-list.csv', 'capability-report.csv'];
// Where a browser that was not stopped would put a download: the user's downloads folder or the
// working folder.
const leftDownloads = (): string[] =>
  DOWNLOAD_NAMES.flatMap((name) => [join(homedir(), 'Downloads', name), join(process.cwd(), name)]).filter((path) => existsSync(path));

const OPENERS = [
  { name: 'a popup opened by the page', locator: role('button', 'Open help') },
  { name: 'a link that opens a second page', locator: role('link', 'Open the guide') },
  { name: 'a download the page starts from a script', locator: role('button', 'Export list') },
  { name: 'a download of a file from the server', locator: role('link', 'Download the report') },
] as const;

for (const targetId of Object.values(BrowserTarget)) {
  describe(`pages and downloads: ${targetId}`, () => {
    for (const opener of OPENERS) {
      test(`${opener.name} fails the step with unsupported-step and skips the rest`, onTarget(targetId), async () => {
        const before = leftDownloads();
        const plan = capability.plan(capabilityPlan(targetId, [
          navigate('/pages.html'),
          click(opener.locator),
          { type: 'capture', name: 'after-opening' },
          textEquals(testId('pages-status'), 'Ready', 'pages.still-ready'),
        ]));
        const { result, store } = await capability.run(plan, targetId);
        assert.equal(result.state, 'Failed');
        assert.deepEqual(result.steps.map((step) => [step.index, step.outcome, step.code]), [
          [0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined], [3, 'skipped', undefined],
        ]);
        assert.deepEqual(store.references(), [], 'nothing was captured after the step');
        assert.deepEqual(leftDownloads(), before, 'no downloaded file was left behind');
      });
    }

    test('counter-example: an ordinary click on the same page passes and the run goes on', onTarget(targetId), async () => {
      const plan = capability.plan(capabilityPlan(targetId, [
        navigate('/pages.html'),
        click(role('button', 'Stay here')),
        { type: 'capture', name: 'after-staying' },
        textEquals(testId('pages-status'), 'Stayed', 'pages.stayed'),
      ]));
      const { result, store } = await capability.run(plan, targetId);
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.equal(store.references().length, 1);
    });

    test('the popup is closed and the session stays on the page that opened it', onTarget(targetId), async () => {
      const session = await capability.openOwn(targetId);
      try {
        assert.ok((await session.navigate(capability.url('/pages.html'), scriptsEnabled)).ok);
        const acted = await session.act(capability.actionStep(click(role('button', 'Open help'))), allowEveryAction);
        assert.equal(acted.ok ? 'passed' : acted.error.code, 'unsupported-step');
        // The page checks its own handle on the popup every 50 ms.
        let popupState = '';
        for (let attempt = 0; attempt < 20 && popupState !== 'closed'; attempt++) {
          popupState = await shownText(capability, session, 'popup-state');
          if (popupState !== 'closed') await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(popupState, 'closed');
        assert.equal(new URL(expectRead(await session.page()).url).pathname, '/pages.html');
      } finally {
        await session.close();
      }
    });
  });
}
