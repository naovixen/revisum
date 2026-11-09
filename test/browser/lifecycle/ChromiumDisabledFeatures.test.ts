// Chromium's port randomisation (TcpPortRandomizationWin) makes about one local connect in sixty
// fail on Windows, so every Chromium a driver starts must have it turned off. Chromium reads only
// the last --disable-features flag on its command line, so these tests read the command line of
// the running browser, take that last flag, and check what it actually disables.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ATTACH_TO_TARGET, CREATE_TARGET, EVALUATE, launchChromium } from '@revisum/driver-cdp';
import { createBrowserDriver } from '#test-support/browser/driver/CreateBrowserDriver.ts';
import { defaultRedactor, type SessionEnvironment, type Target } from '@revisum/engine';
import { BROWSERS } from '#test-support/browser/Browsers.ts';
import type { BrowserHarness } from '#test-support/browser/BrowserHarness.ts';
import { FIXED_TIME_MILLISECONDS, SEED, signupHarness } from '#test-support/browser/harnesses/SignupHarness.ts';
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { baseUrlOf } from "#test-support/builders/ClearRun.ts";

const PORT_RANDOMISATION_FEATURE = 'TcpPortRandomizationWin';
const DISABLE_FEATURES = '--disable-features=';

// The features the last --disable-features flag on a command line turns off, or none when the
// command line has no such flag. Arguments may arrive quoted, as chrome://version shows them.
function lastDisabledFeatures(commandLine: readonly string[]): readonly string[] {
  const flags = commandLine
    .map((argument) => argument.replace(/^"|"$/g, ''))
    .filter((argument) => argument.startsWith(DISABLE_FEATURES));
  const last = flags.at(-1);
  if (last === undefined) {return [];}
  return last.slice(DISABLE_FEATURES.length).split(',').filter((feature) => feature !== '');
}

// The required features that the browser would still run with: those missing from its last
// --disable-features flag. An empty list means every required feature is off.
function featuresLeftOn(commandLine: readonly string[], required: readonly string[]): readonly string[] {
  const disabled = new Set(lastDisabledFeatures(commandLine));
  return required.filter((feature) => !disabled.has(feature));
}

// chrome://version shows the browser's command line as one string, in the element with this id.
const COMMAND_LINE_ELEMENT_ID = 'command_line';
const readCommandLineText = (): string => document.getElementById('command_line')?.textContent ?? '';
const splitCommandLine = (text: string): readonly string[] => text.split(/\s+/).filter((argument) => argument !== '');

let testHarness: BrowserHarness;
before(async () => { testHarness = await signupHarness(); });
after(async () => { await testHarness.close(); });

function contractTarget(targetId: string): Target {
  const target = testHarness.project.matrix.find((candidate) => candidate.id === targetId);
  assert.ok(target !== undefined, `the test project has the target ${targetId}`);
  return target;
}

function sessionEnvironment(): SessionEnvironment {
  return {
    baseUrl: baseUrlOf(testHarness.server.origin), allowedOrigins: testHarness.project.origins, seed: SEED,
    fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, sensitiveSelectors: defaultRedactor().selectors, timeoutMilliseconds: 5000,
  };
}

describe('Chromium port randomisation is off in every browser a driver starts', () => {
  test('the shared Chromium launcher, with its default flags, disables port randomisation', async () => {
    const launched = await launchChromium(BROWSERS.chrome, { profilePrefix: 'disabled-features-test-' });
    try {
      const { targetId } = await launched.connection.ask(undefined, CREATE_TARGET, { url: 'chrome://version' });
      const { sessionId } = await launched.connection.ask(undefined, ATTACH_TO_TARGET, { targetId, flatten: true });
      const page = launched.connection.session(sessionId);
      // Waits for the page to finish loading, then reads the command line element.
      const expression = `new Promise((resolve) => {
        const read = () => resolve(document.getElementById(${JSON.stringify(COMMAND_LINE_ELEMENT_ID)})?.textContent ?? '');
        if (document.readyState === 'complete') read(); else addEventListener('load', read);
      })`;
      const evaluated = await page.ask(EVALUATE, { expression, awaitPromise: true, returnByValue: true });
      const text = evaluated.result.value;
      assert.equal(typeof text, 'string');
      const commandLine = splitCommandLine(String(text));
      assert.ok(commandLine.length > 1, `chrome://version shows the command line: ${String(text)}`);
      assert.deepEqual(featuresLeftOn(commandLine, [PORT_RANDOMISATION_FEATURE]), [], commandLine.join(' '));
    } finally {
      await launched.stop();
    }
  });

  test('the CDP driver\'s browser disables port randomisation', async () => {
    const driver = createBrowserDriver({ executablePath: BROWSERS.chrome });
    const opened = await driver.open(contractTarget('cdp-chromium'), sessionEnvironment());
    assert.ok(opened.ok, 'session opens');
    const session = opened.value;
    try {
      const navigated = await session.navigate('chrome://version', scriptsEnabled);
      assert.ok(navigated.ok, JSON.stringify(navigated));
      const text = await session.evaluate(readCommandLineText);
      const commandLine = splitCommandLine(text);
      assert.ok(commandLine.length > 1, `chrome://version shows the command line: ${text}`);
      assert.deepEqual(featuresLeftOn(commandLine, [PORT_RANDOMISATION_FEATURE]), [], commandLine.join(' '));
    } finally {
      await session.close();
    }
  });

  test('the check fails a command line whose later --disable-features flag drops a feature', () => {
    // An earlier flag that disables the feature does not count: Chromium reads only the last one.
    const overridden = ['chrome', `--disable-features=Translate,${PORT_RANDOMISATION_FEATURE}`, '--headless', '--disable-features=Translate'];
    assert.deepEqual(featuresLeftOn(overridden, [PORT_RANDOMISATION_FEATURE]), [PORT_RANDOMISATION_FEATURE]);
    // A replacement list that keeps the port feature but loses one of the other required features.
    const otherRequired = ['Translate', 'MediaRouter', 'PaintHolding'];
    const shortened = ['chrome', `--disable-features=Translate,PaintHolding,${PORT_RANDOMISATION_FEATURE}`];
    assert.deepEqual(featuresLeftOn(shortened, otherRequired), ['MediaRouter']);
    // No flag at all leaves every feature on; a quoted last flag is still read.
    assert.deepEqual(featuresLeftOn(['chrome', '--headless'], [PORT_RANDOMISATION_FEATURE]), [PORT_RANDOMISATION_FEATURE]);
    assert.deepEqual(featuresLeftOn(['chrome', `"--disable-features=${PORT_RANDOMISATION_FEATURE}"`], [PORT_RANDOMISATION_FEATURE]), []);
  });
});
