// Popups, second pages and downloads are not part of a run yet. On the own CDP driver a step that
// makes the page open a popup or a second page, or start a download, fails with unsupported-step:
// never a pass, never a partial result. The popup is closed, the download is cancelled and no
// file of it is left behind, and every later step is skipped, so nothing is captured after it.
// A counter-example on the same page shows an ordinary click there passes.
// The Playwright fallback refuses the steps only the own driver performs (hover, select, upload,
// frame and dialog) the same way, with nothing sent to the page.
// See docs/specs/SPEC-06-cdp-driver.md.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGETS, PLAYWRIGHT_TARGET, UPLOAD_FIXTURE, capabilityHarness, capabilityPlan, click, label, navigate, role, shownText, testId,
  textEquals, type CapabilityHarness,
} from '../support/capability-harness.ts';

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

for (const targetId of CDP_TARGETS) {
  describe(`pages and downloads: ${targetId}`, () => {
    for (const opener of OPENERS) {
      test(`${opener.name} fails the step with unsupported-step and skips the rest`, { criterion: 'AC-SPEC-06-05' }, async () => {
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

    test('counter-example: an ordinary click on the same page passes and the run goes on', { criterion: 'AC-SPEC-06-05' }, async () => {
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

    test('the popup is closed and the session stays on the page that opened it', { criterion: 'AC-SPEC-06-05' }, async () => {
      const session = await capability.openOwn(targetId);
      try {
        assert.ok((await session.navigate(capability.url('/pages.html'))).ok);
        const acted = await session.act(capability.actionStep(click(role('button', 'Open help'))));
        assert.equal(acted.ok ? 'passed' : acted.error.code, 'unsupported-step');
        // The page checks its own handle on the popup every 50 ms.
        let popupState = '';
        for (let attempt = 0; attempt < 20 && popupState !== 'closed'; attempt++) {
          popupState = await shownText(capability, session, 'popup-state');
          if (popupState !== 'closed') await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(popupState, 'closed');
        assert.equal(new URL((await session.page()).url).pathname, '/pages.html');
      } finally {
        await session.close();
      }
    });
  });
}

describe('the Playwright fallback refuses the steps only the own driver performs', () => {
  const REFUSED = [
    { name: 'a hover', step: { type: 'hover', locator: role('button', 'Help') } },
    { name: 'a select', step: { type: 'select', locator: label('Size'), option: 'Large' } },
    { name: 'an upload', step: { type: 'upload', locator: label('Attachment'), fixture: UPLOAD_FIXTURE } },
    { name: 'a dialog answer', step: { type: 'dialog', action: 'dismiss' } },
  ] as const;

  for (const refused of REFUSED) {
    test(`${refused.name} fails with unsupported-step and sends nothing to the page`, { criterion: 'AC-SPEC-06-05' }, async () => {
      const session = await capability.open(PLAYWRIGHT_TARGET);
      try {
        assert.ok((await session.navigate(capability.url('/guard.html'))).ok);
        const acted = await session.act(capability.actionStep(refused.step));
        assert.equal(acted.ok ? 'passed' : acted.error.code, 'unsupported-step');
        assert.equal(await shownText(capability, session, 'input-events'), '0');
        assert.equal(await shownText(capability, session, 'help-state'), 'closed');
        assert.equal(await shownText(capability, session, 'size-chosen'), 'Small');
        assert.equal(await shownText(capability, session, 'attachment-name'), 'none');
      } finally {
        await session.close();
      }
    });
  }

  test('a frame fails with unsupported-step and none of its steps runs', { criterion: 'AC-SPEC-06-05' }, async () => {
    const plan = capability.plan(capabilityPlan(PLAYWRIGHT_TARGET, [
      navigate('/frame.html'),
      { type: 'frame', locator: testId('checkout-frame'), steps: [textEquals(testId('frame-status'), 'Waiting', 'frame.waiting')] },
      textEquals(testId('outer-status'), 'Not confirmed', 'frame.outer-untouched'),
    ]));
    const { result } = await capability.run(plan, PLAYWRIGHT_TARGET);
    assert.equal(result.state, 'Failed');
    assert.deepEqual(result.steps.map((step) => [step.index, step.outcome, step.code]), [
      [0, 'passed', undefined], [1, 'failed', 'unsupported-step'], [2, 'skipped', undefined],
    ]);
  });

  test('counter-example: a click on the Playwright fallback is sent to the page', { criterion: 'AC-SPEC-06-05' }, async () => {
    const session = await capability.open(PLAYWRIGHT_TARGET);
    try {
      assert.ok((await session.navigate(capability.url('/guard.html'))).ok);
      assert.ok((await session.act(capability.actionStep(click(role('button', 'Save draft'))))).ok);
      assert.equal(await shownText(capability, session, 'save-clicks'), '1');
      assert.notEqual(await shownText(capability, session, 'input-events'), '0');
    } finally {
      await session.close();
    }
  });
});
