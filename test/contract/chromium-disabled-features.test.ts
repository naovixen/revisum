// Chromium's port randomisation (TcpPortRandomizationWin) makes about one local connect in sixty
// fail on Windows, so every Chromium a driver starts must have it turned off. Chromium reads only
// the last --disable-features flag on its command line, so these tests read the command line of
// the running browser, take that last flag, and check what it actually disables. For the
// Playwright driver they also check that none of the features Playwright itself disables by
// default is lost when the driver replaces Playwright's flag with its own.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { after, before, describe, test } from 'node:test';
import { cdpDriver, launchChromium } from '@revisum/driver-cdp';
import { playwrightDriver } from '@revisum/driver-playwright';
import { defaultRedactor, type SessionEnvironment, type Target } from '@revisum/engine';
import { chromium, type Browser } from 'playwright-core';
import { BROWSERS } from '../support/browsers.ts';
import { FIXED_TIME_MILLISECONDS, SEED, harness, type Harness } from '../support/signup-harness.ts';

const PORT_RANDOMISATION_FEATURE = 'TcpPortRandomizationWin';
const DISABLE_FEATURES = '--disable-features=';

// The features the last --disable-features flag on a command line turns off, or none when the
// command line has no such flag. Arguments may arrive quoted, as chrome://version shows them.
function lastDisabledFeatures(commandLine: readonly string[]): readonly string[] {
  const flags = commandLine
    .map((argument) => argument.replace(/^"|"$/g, ''))
    .filter((argument) => argument.startsWith(DISABLE_FEATURES));
  const last = flags.at(-1);
  if (last === undefined) return [];
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

// The command line the operating system holds for a running process.
function processCommandLine(processId: number): readonly string[] {
  if (platform() === 'linux') return readFileSync(`/proc/${processId}/cmdline`, 'utf8').split('\0').filter((argument) => argument !== '');
  const query = platform() === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${processId}").CommandLine`], { encoding: 'utf8', windowsHide: true })
    : spawnSync('ps', ['-o', 'args=', '-p', String(processId)], { encoding: 'utf8' });
  assert.equal(query.status, 0, `reading the command line of process ${processId}: ${query.stderr}`);
  return splitCommandLine(query.stdout);
}

// The arguments a Playwright-launched Chromium was started with. Playwright's headless shell has
// no chrome://version and no --enable-automation (which Browser.getBrowserCommandLine needs), so
// the browser is asked for its own process id and the operating system for that process's
// command line.
async function playwrightCommandLine(browser: Browser): Promise<readonly string[]> {
  const session = await browser.newBrowserCDPSession();
  let processId: number | undefined;
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    processId = processInfo.find((entry) => entry.type === 'browser')?.id;
  } finally {
    await session.detach();
  }
  assert.ok(processId !== undefined, 'the browser reports its own process id');
  const commandLine = processCommandLine(processId);
  assert.ok(commandLine.length > 1, `the operating system shows the command line of process ${processId}`);
  return commandLine;
}

let testHarness: Harness;
before(async () => { testHarness = await harness(); });
after(async () => { await testHarness.close(); });

function contractTarget(targetId: string): Target {
  const target = testHarness.project.matrix.find((candidate) => candidate.id === targetId);
  assert.ok(target, `the test project has the target ${targetId}`);
  return target;
}

function sessionEnvironment(): SessionEnvironment {
  return {
    baseUrl: testHarness.server.origin, allowedOrigins: testHarness.project.origins, seed: SEED,
    fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS, sensitiveSelectors: defaultRedactor().selectors, timeoutMilliseconds: 5000,
  };
}

describe('Chromium port randomisation is off in every browser a driver starts', () => {
  test('the shared Chromium launcher, with its default flags, disables port randomisation', { criterion: 'AC-SPEC-00-01' }, async () => {
    const launched = await launchChromium(BROWSERS.chrome, { profilePrefix: 'disabled-features-test-' });
    try {
      const { targetId } = await launched.connection.send<{ targetId: string }>(undefined, 'Target.createTarget', { url: 'chrome://version' });
      const { sessionId } = await launched.connection.send<{ sessionId: string }>(undefined, 'Target.attachToTarget', { targetId, flatten: true });
      const page = launched.connection.session(sessionId);
      // Waits for the page to finish loading, then reads the command line element.
      const expression = `new Promise((resolve) => {
        const read = () => resolve(document.getElementById(${JSON.stringify(COMMAND_LINE_ELEMENT_ID)})?.textContent ?? '');
        if (document.readyState === 'complete') read(); else addEventListener('load', read);
      })`;
      const evaluated = await page.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const text = evaluated.result.value;
      assert.equal(typeof text, 'string');
      const commandLine = splitCommandLine(String(text));
      assert.ok(commandLine.length > 1, `chrome://version shows the command line: ${String(text)}`);
      assert.deepEqual(featuresLeftOn(commandLine, [PORT_RANDOMISATION_FEATURE]), [], commandLine.join(' '));
    } finally {
      await launched.stop();
    }
  });

  test('the CDP driver\'s browser disables port randomisation', { criterion: 'AC-SPEC-00-01' }, async () => {
    const driver = cdpDriver({ executablePath: BROWSERS.chrome });
    const opened = await driver.open(contractTarget('cdp-chromium'), sessionEnvironment());
    assert.ok(opened.ok, 'session opens');
    const session = opened.value;
    try {
      const navigated = await session.navigate('chrome://version');
      assert.ok(navigated.ok, JSON.stringify(navigated));
      const text = await session.evaluate(readCommandLineText);
      const commandLine = splitCommandLine(text);
      assert.ok(commandLine.length > 1, `chrome://version shows the command line: ${text}`);
      assert.deepEqual(featuresLeftOn(commandLine, [PORT_RANDOMISATION_FEATURE]), [], commandLine.join(' '));
    } finally {
      await session.close();
    }
  });

  test('the Playwright driver\'s Chromium disables port randomisation and every feature Playwright disables by default', { criterion: 'AC-SPEC-00-01' }, async () => {
    // What the installed Playwright disables when it launches Chromium with no overrides.
    const plain = await chromium.launch({ headless: true });
    let playwrightDefaults: readonly string[];
    try {
      playwrightDefaults = lastDisabledFeatures(await playwrightCommandLine(plain));
    } finally {
      await plain.close();
    }
    assert.ok(playwrightDefaults.length > 0, 'Playwright disables some Chromium features by default');

    // The driver launches through the same playwright-core module, so a wrapper on its
    // chromium.launch hands this test the browser the driver started.
    const launched: Browser[] = [];
    const originalLaunch = chromium.launch;
    chromium.launch = async (options) => {
      const browser = await originalLaunch.call(chromium, options);
      launched.push(browser);
      return browser;
    };
    let commandLine: readonly string[];
    try {
      const opened = await playwrightDriver().open(contractTarget('playwright-chromium'), sessionEnvironment());
      chromium.launch = originalLaunch;
      assert.ok(opened.ok, `session opens: ${JSON.stringify(opened.ok ? null : opened.error)}`);
      try {
        const browser = launched[0];
        assert.ok(browser !== undefined && launched.length === 1, 'the driver launched one Chromium through playwright-core');
        commandLine = await playwrightCommandLine(browser);
      } finally {
        await opened.value.close();
      }
    } finally {
      chromium.launch = originalLaunch;
    }
    assert.deepEqual(featuresLeftOn(commandLine, [PORT_RANDOMISATION_FEATURE]), [], commandLine.join(' '));
    assert.deepEqual(featuresLeftOn(commandLine, playwrightDefaults), [], commandLine.join(' '));
  });

  test('the check fails a command line whose later --disable-features flag drops a feature', { criterion: 'AC-SPEC-00-01' }, () => {
    // An earlier flag that disables the feature does not count: Chromium reads only the last one.
    const overridden = ['chrome', `--disable-features=Translate,${PORT_RANDOMISATION_FEATURE}`, '--headless', '--disable-features=Translate'];
    assert.deepEqual(featuresLeftOn(overridden, [PORT_RANDOMISATION_FEATURE]), [PORT_RANDOMISATION_FEATURE]);
    // A replacement list that keeps the port feature but loses one of Playwright's defaults.
    const playwrightDefaults = ['Translate', 'MediaRouter', 'PaintHolding'];
    const shortened = ['chrome', `--disable-features=Translate,PaintHolding,${PORT_RANDOMISATION_FEATURE}`];
    assert.deepEqual(featuresLeftOn(shortened, playwrightDefaults), ['MediaRouter']);
    // No flag at all leaves every feature on; a quoted last flag is still read.
    assert.deepEqual(featuresLeftOn(['chrome', '--headless'], [PORT_RANDOMISATION_FEATURE]), [PORT_RANDOMISATION_FEATURE]);
    assert.deepEqual(featuresLeftOn(['chrome', `"--disable-features=${PORT_RANDOMISATION_FEATURE}"`], [PORT_RANDOMISATION_FEATURE]), []);
  });
});
