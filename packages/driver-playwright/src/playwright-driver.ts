// The fallback driver: Chromium, Firefox and WebKit through Playwright, always headless. It
// stays until the own drivers pass the capability contract tests.
// See docs/decisions/browser-and-audit-dependencies.md.
import {
  determinismScript, deviceProfile, failure, literalActionStep, performableLocator, reveal, success,
  type ActionStep, type BrowserDriver, type DriverError, type ElementProbe, type Key, type ResolvedLocator,
  type Result, type Secret, type Session, type SessionEnvironment, type Target,
} from '@revisum/contracts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, firefox, webkit, type Browser, type Locator as PlaywrightLocator, type Page } from 'playwright-core';
import { AXE_SOURCE, AXE_TAGS, runAxe, toFindings } from './axe-audit.ts';
import { accessibilitySnapshot, probeElement } from './in-page.ts';

const requireFromHere = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = (JSON.parse(readFileSync(requireFromHere.resolve('playwright-core/package.json'), 'utf8')) as { version: string }).version;
const ENGINES = { chromium, firefox, webkit } as const;
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
      let browser: Browser;
      try {
        browser = await ENGINES[target.engine].launch({ headless: true });
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
    async act(step, _guard, secret) {
      return act(page, step, timeout, secret);
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

async function act(page: Page, step: ActionStep, timeout: number, secret: Secret | undefined): Promise<Result<void, DriverError>> {
  // The engine does not send these yet (it reports them as unsupported-step); refuse them here too.
  if (step.type === 'hover' || step.type === 'select' || step.type === 'upload') {
    return failure({ code: 'not-actionable', detail: `this driver does not perform ${step.type} steps yet` });
  }
  // Anything this driver cannot perform in full is refused before it touches the page.
  const action = literalActionStep(step);
  if (action === undefined) return failure({ code: 'not-actionable', detail: `this driver does not perform this ${step.type} step yet` });
  // A secret reference arrives with the secret the engine resolved for it. Without that secret
  // there is nothing to type, and typing nothing could pass a step that should fail.
  if (action.type === 'fill' && typeof action.value !== 'string' && secret?.name !== action.value.secretName) {
    return failure({ code: 'not-actionable', detail: 'a secret reference reached the driver without its secret' });
  }
  const found = locate(page, action.locator);
  try {
    switch (action.type) {
      case 'click': await found.click({ timeout }); break;
      // The secret is revealed here, as it is typed, and nowhere else in this driver.
      case 'fill': await found.fill(typeof action.value === 'string' ? action.value : reveal(secret ?? missingSecret()), { timeout }); break;
      case 'press': await found.press(keyName(action.key), { timeout }); break;
      case 'hover': case 'select': case 'upload': break;
    }
    return success(undefined);
  } catch (error) {
    const count = await found.count().catch(() => 0);
    return failure(driverError(count === 0 ? 'not-found' : count > 1 ? 'ambiguous' : 'not-actionable', error));
  }
}

// Unreachable: act() refuses a secret reference without its secret before it locates anything.
function missingSecret(): never {
  throw new Error('a secret reference reached the driver without its secret');
}

const driverError = (code: DriverError['code'], error: unknown): DriverError =>
  ({ code, detail: (error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)).slice(0, 200) });
