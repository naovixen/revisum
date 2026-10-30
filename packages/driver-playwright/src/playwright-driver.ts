// The fallback driver: Chromium, Firefox and WebKit through Playwright, always headless. It
// stays until the own drivers pass the capability contract tests. It clicks, fills and presses,
// asking the policy gate's runtime guard first; the steps only the own CDP driver performs (hover,
// select, upload, frame and dialog) it refuses with unsupported-step, with nothing sent.
// See docs/decisions/browser-and-audit-dependencies.md.
import {
  determinismScript, deviceProfile, failure, literalActionStep, performableLocator, reveal, success,
  type ActionGuard, type ActionStep, type BrowserDriver, type DriverError, type ElementProbe, type Key, type ResolvedElement, type ResolvedLocator,
  type Result, type Secret, type Session, type SessionEnvironment, type Target,
} from '@revisum/contracts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, firefox, webkit, type Browser, type Locator as PlaywrightLocator, type Page } from 'playwright-core';
import { AXE_SOURCE, AXE_TAGS, runAxe, toFindings } from './axe-audit.ts';
import { accessibilitySnapshot, probeElement, resolvedElement } from './in-page.ts';

const requireFromHere = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = (JSON.parse(readFileSync(requireFromHere.resolve('playwright-core/package.json'), 'utf8')) as { version: string }).version;
const ENGINES = { chromium, firefox, webkit } as const;

// Chromium's request for a random local port on every connection (SO_RANDOMIZE_PORT) makes
// Windows fail about one connect in sixty with WSAENOBUFS, seen as net::ERR_NO_BUFFER_SPACE: a
// page or one of its files fails to load even on 127.0.0.1. The driver turns that feature off.
// The CDP driver does the same; see its chrome-flags.ts.
const PORT_RANDOMISATION_FEATURE = 'TcpPortRandomizationWin';
// Chromium reads only the last --disable-features flag, and Playwright passes its own list. So
// the driver replaces Playwright's flag with one list: Playwright's features plus the one above.
// The list is copied from the Playwright version below; with any other version Chromium is not
// started, so a changed list can never be dropped without notice.
const FEATURE_LIST_PLAYWRIGHT_VERSION = '1.64.1';
const PLAYWRIGHT_DISABLED_FEATURES = '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,'
  + 'DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,'
  + 'BlockOriginHeaderModificationOnRedirect,AvoidCorsURLLoaderRestartOnRedirect,Translate,AutoDeElevate,OptimizationHints,'
  + 'NetworkTimeServiceQuerying,AimEnabled,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion';

type LaunchSettings = Result<Parameters<typeof chromium.launch>[0], string>;

function launchSettings(engine: Target['engine']): LaunchSettings {
  if (engine !== 'chromium') return success({ headless: true });
  if (PLAYWRIGHT_VERSION !== FEATURE_LIST_PLAYWRIGHT_VERSION) {
    return failure(`Playwright ${PLAYWRIGHT_VERSION} may pass other Chromium features than ${FEATURE_LIST_PLAYWRIGHT_VERSION}: `
      + 'update the copied feature list in playwright-driver.ts');
  }
  return success({
    headless: true,
    ignoreDefaultArgs: [PLAYWRIGHT_DISABLED_FEATURES],
    args: [`${PLAYWRIGHT_DISABLED_FEATURES},${PORT_RANDOMISATION_FEATURE}`],
  });
}

// Every plan key is also a Playwright key name: named keys, letters, digits, the physical names of
// punctuation keys (such as Backquote) and F1 to F12.
const keyName = (key: Key): string => key;
const NO_ELEMENT: ElementProbe = { count: 0, visible: false, enabled: false, text: '', value: null, sensitive: false, box: null };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function playwrightDriver(): BrowserDriver {
  return {
    info: { id: 'playwright', version: PLAYWRIGHT_VERSION, protocol: 'Playwright (CDP, Juggler, WebKit remote)' },
    supports(target) {
      if (deviceProfile(target).mobile && target.engine === 'firefox') {
        return failure({ reason: 'device-not-supported', detail: 'Playwright Firefox cannot emulate mobile devices (isMobile)' });
      }
      return success(true);
    },
    async open(target, environment) {
      const settings = launchSettings(target.engine);
      if (!settings.ok) return failure({ reason: 'launch-failed', detail: settings.error });
      let browser: Browser;
      try {
        browser = await ENGINES[target.engine].launch(settings.value);
      } catch (error) {
        return failure({ reason: 'launch-failed', detail: errorText(error) });
      }
      try {
        return success(await createSession(browser, target, environment));
      } catch (error) {
        await browser.close();
        return failure({ reason: 'launch-failed', detail: errorText(error) });
      }
    },
  };
}

async function createSession(browser: Browser, target: Target, environment: SessionEnvironment): Promise<Session> {
  const profile = deviceProfile(target);
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.scale,
    ...(target.engine === 'firefox' ? {} : { isMobile: profile.mobile }),
    hasTouch: profile.touch,
    locale: target.locale,
    timezoneId: target.timezone,
    colorScheme: target.colorScheme,
    reducedMotion: target.reducedMotion,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  await context.addInitScript({ content: determinismScript(environment.seed, environment.fixedTimeMilliseconds) });
  // Every request is either let through (allowed origin) or aborted and recorded.
  const blocked: string[] = [];
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (environment.allowedOrigins.includes(url.origin)) return route.continue();
    blocked.push(url.origin);
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  const timeout = environment.timeoutMilliseconds;

  return {
    browser: { name: target.engine, version: browser.version() },
    blockedOrigins: () => blocked,
    async navigate(url) {
      try {
        await page.goto(url, { waitUntil: 'load', timeout });
        return success(undefined);
      } catch (error) {
        return failure(driverError('navigation-failed', error));
      }
    },
    async page() {
      return { url: page.url(), title: await page.title() };
    },
    async act(step, guard, secret) {
      return act(page, step, timeout, guard, secret);
    },
    async probe(planLocator) {
      // A value reference, a position or another test-id attribute matches nothing here yet.
      const locator = performableLocator(planLocator);
      if (locator === undefined) return NO_ELEMENT;
      const found = locate(page, locator);
      try {
        const count = await found.count();
        if (count !== 1) return { ...NO_ELEMENT, count };
        return JSON.parse(await found.evaluate(probeElement, [...environment.sensitiveSelectors])) as ElementProbe;
      } catch {
        return NO_ELEMENT;
      }
    },
    async screenshot(mask) {
      await page.evaluate(() => document.fonts.ready.then(() => true));
      const png = await page.screenshot({
        type: 'png', animations: 'disabled', caret: 'hide', scale: 'css',
        mask: mask.map((selector) => page.locator(selector)), maskColor: '#000000',
      });
      return new Uint8Array(png);
    },
    async audit() {
      await page.addScriptTag({ content: AXE_SOURCE });
      return toFindings(await page.evaluate(runAxe, AXE_TAGS));
    },
    async accessibilitySnapshot() {
      return JSON.parse(await page.evaluate(accessibilitySnapshot));
    },
    async close() {
      await browser.close();
    },
  };
}

function locate(page: Page, locator: ResolvedLocator): PlaywrightLocator {
  switch (locator.by) {
    case 'role': return page.getByRole(locator.role, { name: locator.name, exact: true });
    case 'label': return page.getByLabel(locator.label, { exact: true });
    case 'text': return page.getByText(locator.text, { exact: true });
    case 'testId': return page.getByTestId(locator.testId);
  }
}

// Steps the own CDP driver performs and this fallback does not.
const OWN_DRIVER_STEPS: readonly ActionStep['type'][] = ['hover', 'select', 'upload', 'dialog'];

async function act(
  page: Page, step: ActionStep, timeout: number, guard: ActionGuard | undefined, secret: Secret | undefined,
): Promise<Result<void, DriverError>> {
  if (OWN_DRIVER_STEPS.includes(step.type)) {
    return failure({ code: 'unsupported-step', detail: `the Playwright fallback does not perform ${step.type} steps` });
  }
  // Anything this driver cannot perform in full is refused before it touches the page.
  const action = literalActionStep(step);
  if (action === undefined) return failure({ code: 'unsupported-step', detail: `this driver does not perform this ${step.type} step yet` });
  // A secret reference arrives with the secret the engine resolved for it. Without that secret
  // there is nothing to type, and typing nothing could pass a step that should fail.
  // It declares no optional feature, so it is never given lines to fill; checked all the same.
  if (action.type === 'fill' && typeof action.value !== 'string' && 'lines' in action.value) {
    return failure({ code: 'unsupported-step', detail: 'the Playwright fallback does not perform multi-line fills' });
  }
  if (action.type === 'fill' && typeof action.value !== 'string' && 'secretName' in action.value && secret?.name !== action.value.secretName) {
    return failure({ code: 'not-actionable', detail: 'a secret reference reached the driver without its secret' });
  }
  const found = locate(page, action.locator);
  const deadline = Date.now() + timeout;
  const remaining = (): number => Math.max(deadline - Date.now(), 1);
  try {
    // The element is resolved and shown to the guard before any input event.
    if (guard !== undefined) {
      await found.waitFor({ state: 'visible', timeout: remaining() });
      const verdict = guard(decodeResolvedElement(await found.evaluate(resolvedElement)), null);
      if (verdict.kind === 'deny') return failure({ code: 'policy-denied', detail: `denied by the ${verdict.rule} rule` });
    }
    switch (action.type) {
      case 'click': await found.click({ timeout: remaining() }); break;
      // The secret is revealed here, as it is typed, and nowhere else in this driver.
      case 'fill': await found.fill(typeof action.value === 'string' ? action.value : reveal(secret ?? missingSecret()), { timeout: remaining() }); break;
      case 'press': await found.press(keyName(action.key), { timeout: remaining() }); break;
      // Refused above, before the element was looked for.
      case 'hover': case 'select': case 'upload': return failure({ code: 'unsupported-step', detail: `the Playwright fallback does not perform ${action.type} steps` });
    }
    return success(undefined);
  } catch (error) {
    const count = await found.count().catch(() => 0);
    return failure(driverError(count === 0 ? 'not-found' : count > 1 ? 'ambiguous' : 'not-actionable', error));
  }
}

// Decodes what resolvedElement (in-page.ts) reports. A field of another shape is read as not shown.
function decodeResolvedElement(text: string): ResolvedElement {
  const parsed: unknown = JSON.parse(text);
  const fields = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  const box = fields['box'];
  const boxFields = typeof box === 'object' && box !== null ? box as Record<string, unknown> : {};
  const [x, y, width, height] = [boxFields['x'], boxFields['y'], boxFields['width'], boxFields['height']];
  const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  const testId = textOrNull(fields['testId']);
  return {
    role: textOrNull(fields['role']),
    name: textOrNull(fields['name']),
    box: typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number' ? { x, y, width, height } : null,
    formSubmitName: textOrNull(fields['formSubmitName']),
    linkUrl: textOrNull(fields['linkUrl']),
    ...(testId === null ? {} : { testId }),
  };
}

// Unreachable: act() refuses a secret reference without its secret before it locates anything.
function missingSecret(): never {
  throw new Error('a secret reference reached the driver without its secret');
}

const driverError = (code: DriverError['code'], error: unknown): DriverError =>
  ({ code, detail: (error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)).slice(0, 200) });
