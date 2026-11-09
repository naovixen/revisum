// Accessibility engine checks that drive headless Chromium over CDP: the page snapshot, command
// timeouts and process clean-up, the network block, the Tab walk and repeatable scans.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchBrowser, scan, tabWalk, type Browser, type PageDriver } from '@revisum/auditor-act';
import { ATTACH_TO_TARGET, CREATE_TARGET, EVALUATE, launchChromium } from '@revisum/driver-cdp';
import { CLOSE_THE_BROWSER, NO_SUCH_COMMAND } from '#test-support/browser/TestCommand.ts';
import { startAccessibilityServer, type AccessibilityServer } from '../../support/browser/harnesses/AccessibilityServer.ts';
import { BROWSERS } from '../../support/browser/Browsers.ts';
import { createCleanUpScope } from '../../support/CleanUpScope.ts';

const cleanUps = createCleanUpScope();
let browser: Browser;
let page: PageDriver;
let server: AccessibilityServer;
before(async () => {
  server = await startAccessibilityServer();
  cleanUps.add(() => server.close());
  browser = await launchBrowser(BROWSERS.chrome);
  cleanUps.add(() => browser.close());
  page = await browser.newPage();
  cleanUps.add(() => page.close());
}, { timeout: 60_000 });
after(() => cleanUps.runAll());

test('the snapshot holds DOM nodes, computed styles, layout boxes and accessibility-tree role and name', { timeout: 60_000 }, async () => {
  await page.goto(`${server.origin}/keyboard-pairs/k10-sequence.clean.html`);
  const snapshot = await page.snapshot();
  const button = snapshot.nodes.find((node) => node.attributes['id'] === 's1');
  assert.ok(button !== undefined, 'button node');
  assert.equal(button.name, 'button');
  assert.ok(button.style !== null && (button.style['display'] ?? '') !== '', 'computed style');
  assert.ok(button.bounds !== null && button.bounds.width > 0 && button.bounds.height > 0, 'layout box');
  assert.equal(button.accessibility?.role, 'button');
  assert.equal(button.accessibility.name, 'One');
  const input = snapshot.nodes.find((node) => node.attributes['id'] === 's4');
  assert.equal(input?.accessibility?.name, 'Four');
});

test('CDP commands time out and closing ends the launched browser process', { timeout: 60_000 }, async () => {
  // A command that never answers is rejected by the client's timeout.
  const launched = await launchChromium(BROWSERS.chrome);
  const { targetId } = await launched.connection.ask(undefined, CREATE_TARGET, { url: 'about:blank' });
  const { sessionId } = await launched.connection.ask(undefined, ATTACH_TO_TARGET, { targetId, flatten: true });
  await assert.rejects(launched.connection.ask(sessionId, EVALUATE, { expression: 'new Promise(() => {})', awaitPromise: true }, 500), /timeout after 500 ms/);
  await assert.rejects(launched.connection.ask(sessionId, NO_SUCH_COMMAND, {}, 5000), /No.suchMethod/);
  await launched.connection.ask(undefined, CLOSE_THE_BROWSER, {}, 5000).catch(() => undefined);
  for (let i = 0; i < 200 && launched.browserProcess.exitCode === null; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.notEqual(launched.browserProcess.exitCode, null);
  launched.connection.close();
  const second = await launchBrowser(BROWSERS.chrome);
  const secondPage = await second.newPage();
  await secondPage.close();
  await second.close();
  assert.equal(second.exited(), true);
});

test('the browser cannot reach the network outside 127.0.0.1', { timeout: 60_000 }, async () => {
  await page.goto(`${server.origin}/keyboard-pairs/k10-sequence.clean.html`);
  const external = String(await page.evaluate(`fetch('http://example.com/').then(() => 'reached', (e) => 'blocked: ' + e.message)`));
  assert.match(external, /^blocked/);
  const local: unknown = await page.evaluate(`fetch(location.href).then((r) => r.status)`);
  assert.equal(local, 200);
});

test('the Tab walk records the exact focus sequence, positive tabindex first', { timeout: 60_000 }, async () => {
  await page.goto(`${server.origin}/keyboard-pairs/k10-sequence.clean.html`);
  const snapshot = await page.snapshot();
  const walk = await tabWalk(page, snapshot, { focusVisibility: false, occlusion: false });
  const ids = walk.sequence.map((index) => snapshot.nodes[index]?.attributes['id']);
  assert.deepEqual(ids, ['s2', 's1', 's3', 's4']);
  assert.equal(walk.endedAtDocument, true);
});

test('scanning the same page twice yields byte-identical findings', { timeout: 120_000 }, async () => {
  for (const path of ['/mapping-pairs/sc143-low-contrast.fail.html', '/keyboard-pairs/k05-order-tabindex.fail.html', '/keyboard-pairs/k03-focus-outline-none.fail.html']) {
    const first = await scan(page, server.origin + path, { page: path });
    const second = await scan(page, server.origin + path, { page: path });
    assert.ok(first.findings.length > 0, path);
    assert.equal(JSON.stringify(first.findings), JSON.stringify(second.findings), path);
  }
});
