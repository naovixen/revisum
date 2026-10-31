// The fallback driver: Chromium, Firefox and WebKit through Playwright, always headless. It
// stays until the own drivers pass the capability contract tests. It clicks, fills and presses,
// asking the policy gate's runtime guard first; the steps only the own CDP driver performs (hover,
// select, upload, frame and dialog) it refuses with unsupported-step, with nothing sent. Of the
// optional plan features it performs only those of plan language 1.3's page parts: CSS and XPath
// locators, DOM checks and page scripts.
// See docs/decisions/browser-and-audit-dependencies.md and docs/specs/SPEC-36-unsafe-plan-features.md.
import {
  determinismScript, deviceProfile, failure, literalActionStep, performableLocator, reveal, success,
  type ActionGuard, type ActionStep, type BrowserDriver, type DomRead, type DomValue, type DriverError, type DriverFeature, type ElementProbe, type Key,
  type PageScriptCall, type ResolvedElement, type ResolvedLocator, type Result, type Secret, type Session, type SessionEnvironment, type Target,
} from '@revisum/contracts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, firefox, webkit, type Browser, type Locator as PlaywrightLocator, type Page } from 'playwright-core';
import { AXE_SOURCE, AXE_TAGS, runAxe, toFindings } from './axe-audit.ts';
import { accessibilitySnapshot, probeElement, readDomValue, resolvedElement, runPageScript, structuralSelectorValidity } from './in-page.ts';

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
const SELECTOR_INVALID: DriverError = { code: 'selector-invalid', detail: 'the browser rejects a CSS selector or XPath expression of the locator' };

// The optional plan features this fallback performs: CSS and XPath locators, DOM checks and page
// scripts. It declares no feature of plan language 1.2's, such as positions or remembered values.
const PLAYWRIGHT_FEATURES: readonly DriverFeature[] = ['structuralLocators', 'domChecks', 'pageScripts'];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function playwrightDriver(): BrowserDriver {
  return {
    info: { id: 'playwright', version: PLAYWRIGHT_VERSION, protocol: 'Playwright (CDP, Juggler, WebKit remote)', performs: PLAYWRIGHT_FEATURES },
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
    async probe(planLocator, read) {
      // A value reference, a position or another test-id attribute matches nothing here yet.
      const locator = performableLocator(planLocator, PLAYWRIGHT_FEATURES);
      if (locator === undefined) return NO_ELEMENT;
      try {
        if (await rejectsSelector(page, locator)) return { ...NO_ELEMENT, selectorInvalid: true };
        const found = await locate(page, locator);
        if (found === null) return NO_ELEMENT;
        const count = await found.count();
        if (count !== 1) return { ...NO_ELEMENT, count };
        const shown = JSON.parse(await found.evaluate(probeElement, [...environment.sensitiveSelectors])) as ElementProbe;
        // A DOM check's read: a class list, a computed style or an attribute, read from the document.
        const dom = read === undefined ? undefined : decodeDomValue(await found.evaluate(readDomValue, [read.kind, domReadName(read)] as const), read);
        return dom === undefined ? shown : { ...shown, dom };
      } catch {
        return NO_ELEMENT;
      }
    },
    runScript: (call) => runScript(page, call),
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

// The Playwright locator for a plan locator, or null when a locator it is inside does not find
// exactly one element: the selector is then evaluated nowhere, as on the own CDP driver.
async function locate(page: Page, locator: ResolvedLocator): Promise<PlaywrightLocator | null> {
  switch (locator.by) {
    case 'role': return page.getByRole(locator.role, { name: locator.name, exact: true });
    case 'label': return page.getByLabel(locator.label, { exact: true });
    case 'text': return page.getByText(locator.text, { exact: true });
    case 'testId': return page.getByTestId(locator.testId);
    case 'css': case 'xpath': {
      let scope: Page | PlaywrightLocator = page;
      if (locator.inside !== undefined) {
        const inside = await locate(page, locator.inside);
        if (inside === null || await inside.count() !== 1) return null;
        scope = inside;
      }
      const found = scope.locator(locator.by === 'css' ? `css=${locator.selector}` : `xpath=${locator.expression}`);
      // Playwright's hasText: the text content contains it, white space collapsed, ignoring case.
      return locator.hasText === undefined ? found : found.filter({ hasText: locator.hasText });
    }
  }
}

// True when the browser rejects a CSS selector or XPath expression of the locator or of a locator
// it is inside.
async function rejectsSelector(page: Page, locator: ResolvedLocator): Promise<boolean> {
  if (locator.by !== 'css' && locator.by !== 'xpath') return false;
  const text = locator.by === 'css' ? locator.selector : locator.expression;
  if (await page.evaluate(structuralSelectorValidity, [locator.by, text] as const) === 'invalid') return true;
  return locator.inside !== undefined && rejectsSelector(page, locator.inside);
}

// The style property or attribute a DOM read names; empty for the class list.
const domReadName = (read: DomRead): string => (read.kind === 'computedStyle' ? read.property : read.kind === 'attribute' ? read.name : '');

// Decodes what readDomValue (in-page.ts) reports, keeping it only when it is the read asked for.
function decodeDomValue(text: string, read: DomRead): DomValue | undefined {
  const parsed: unknown = JSON.parse(text);
  const fields = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  const [classes, value] = [fields['classes'], fields['value']];
  switch (read.kind) {
    case 'classes':
      return Array.isArray(classes) && classes.every((token) => typeof token === 'string') ? { kind: 'classes', classes: [...classes] } : undefined;
    case 'computedStyle': return typeof value === 'string' ? { kind: 'computedStyle', value } : undefined;
    case 'attribute': return typeof value === 'string' || value === null ? { kind: 'attribute', value } : undefined;
  }
}

// A page script in the page's main world, raced against its timeout in real time. A script that
// never settles is left to the page: the run ends without it, and closing the browser ends it.
async function runScript(page: Page, call: PageScriptCall): Promise<Result<string, DriverError>> {
  const called = page.evaluate(runPageScript, [call.source, call.arguments, call.maximumResultBytes] as const);
  called.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timed-out'>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout('timed-out'), call.timeoutMilliseconds); });
  let ended: readonly string[] | 'timed-out';
  try {
    ended = await Promise.race([called, timedOut]);
  } catch (error) {
    return failure(driverError('script-failed', error));
  } finally {
    clearTimeout(timer);
  }
  if (ended === 'timed-out') return failure({ code: 'script-timeout', detail: `the script did not settle within ${call.timeoutMilliseconds} ms` });
  const [kind, text] = ended;
  if (kind === 'text' && typeof text === 'string') return success(text);
  if (kind === 'threw') return failure({ code: 'script-failed', detail: 'the script threw or its promise was rejected' });
  return failure({ code: 'script-result-invalid', detail: 'the script\'s result is not a value JSON can write' });
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
  const action = literalActionStep(step, PLAYWRIGHT_FEATURES);
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
  let located: PlaywrightLocator | null;
  try {
    if (await rejectsSelector(page, action.locator)) return failure(SELECTOR_INVALID);
    located = await locate(page, action.locator);
  } catch (error) {
    return failure(driverError('not-actionable', error));
  }
  if (located === null) return failure({ code: 'not-found', detail: 'the locator this one is inside does not find exactly one element' });
  const found = located;
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
