// Turns any protocol's PageOperations into a Session. Auto-waiting, probing, masking and
// auditing live here once, so every protocol behaves the same way.
import {
  failure, literalActionStep, performableLocator, reveal, success,
  type ActionGuard, type ActionStep, type DriverError, type ElementProbe, type Locator, type PageProbe, type ResolvedLocator, type Result,
  type Secret, type SessionEnvironment,
} from '@revisum/contracts';
import {
  actionability, armHitCheck, findByLabel, findByTestId, findByText, fontsReady, maskElements, pageInfo, probeElement,
  readHitCheck, unmaskElements,
} from './in-page.ts';
import { pageAudit, parseAudit, toFindings } from './page-audit.ts';
import type { Actionability, DriverSession, PageFunction, PageOperations } from './page-operations.ts';

export const NO_ELEMENT: ElementProbe = { count: 0, visible: false, enabled: false, text: '', value: null, sensitive: false, box: null };
const POLL_INTERVAL_MILLISECONDS = 50;

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export type SessionDetails = {
  readonly browser: { readonly name: string; readonly version: string };
  readonly processId: number;
  readonly blockedOrigins: () => readonly string[];
  readonly close: () => Promise<void>;
};

// Finds the elements a locator matches. An error while the page navigates counts as "nothing found yet".
export async function locate<Handle>(operations: PageOperations<Handle>, locator: ResolvedLocator): Promise<Handle[]> {
  try {
    switch (locator.by) {
      case 'role': return await operations.byRole(locator.role, locator.name);
      case 'label': return await operations.callForElements(findByLabel, [locator.label]);
      case 'text': return await operations.callForElements(findByText, [locator.text]);
      case 'testId': return await operations.callForElements(findByTestId, [locator.testId]);
    }
  } catch {
    return [];
  }
}

type Actionable<Handle> = Result<{ readonly element: Handle; readonly at: { x: number; y: number } }, DriverError>;

// Auto-wait: exactly one match that is attached, visible, stable, enabled and hit by a pointer at
// its centre. Never the first of several matches; a typed failure at the deadline.
export async function waitUntilActionable<Handle>(
  operations: PageOperations<Handle>, locator: ResolvedLocator, timeoutMilliseconds: number,
): Promise<Actionable<Handle>> {
  const deadline = Date.now() + timeoutMilliseconds;
  let count = 0;
  let last: Actionability | null = null;
  for (;;) {
    const found = await locate(operations, locator);
    count = found.length;
    const element = found[0];
    if (count === 1 && element !== undefined) {
      try {
        last = JSON.parse(await operations.callForString(actionability, [{ element }])) as Actionability;
        if (last.attached && last.visible && last.stable && last.enabled && last.receivesEvents && last.centre) {
          return success({ element, at: last.centre });
        }
      } catch {
        last = null; // detached during the check: locate again
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MILLISECONDS));
  }
  if (count === 0) return failure({ code: 'not-found', detail: `not-found after ${timeoutMilliseconds} ms` });
  if (count > 1) return failure({ code: 'ambiguous', detail: `${count} matches after ${timeoutMilliseconds} ms` });
  const lastCheck = last;
  const missing = lastCheck === null ? 'attached'
    : (['attached', 'visible', 'stable', 'enabled', 'receivesEvents'] as const).find((key) => !lastCheck[key]) ?? 'unknown';
  return failure({ code: 'not-actionable', detail: `not ${missing} after ${timeoutMilliseconds} ms` });
}

export function buildSession<Handle>(operations: PageOperations<Handle>, environment: SessionEnvironment, details: SessionDetails): DriverSession {
  const probe = async (planLocator: Locator): Promise<ElementProbe> => {
    // A value reference, a position or another test-id attribute matches nothing here yet.
    const locator = performableLocator(planLocator);
    if (locator === undefined) return NO_ELEMENT;
    const found = await locate(operations, locator);
    const element = found[0];
    if (found.length !== 1 || element === undefined) return { ...NO_ELEMENT, count: found.length };
    try {
      return JSON.parse(await operations.callForString(probeElement, [{ element }, environment.sensitiveSelectors])) as ElementProbe;
    } catch {
      return NO_ELEMENT;
    }
  };
  // A click with a hit-target check: a click that lands on another element is swallowed in the page and retried.
  const click = async (locator: ResolvedLocator): Promise<Result<void, DriverError>> => {
    const deadline = Date.now() + environment.timeoutMilliseconds;
    for (;;) {
      const waited = await waitUntilActionable(operations, locator, Math.max(deadline - Date.now(), 0));
      if (!waited.ok) return waited;
      await operations.callForString(armHitCheck, [{ element: waited.value.element }]);
      await operations.click(waited.value.element, waited.value.at);
      let hit = 'hit';
      try { hit = await operations.callForString(readHitCheck, []); } catch { /* the click navigated, so it landed */ }
      if (hit !== 'miss') return success(undefined);
      if (Date.now() >= deadline) {
        return failure({ code: 'not-actionable', detail: `click landed on another element until ${environment.timeoutMilliseconds} ms` });
      }
    }
  };
  const act = async (step: ActionStep, _guard?: ActionGuard, secret?: Secret): Promise<Result<void, DriverError>> => {
    // The engine does not send these yet (it reports them as unsupported-step); refuse them here too.
    if (step.type === 'hover' || step.type === 'select' || step.type === 'upload') {
      return failure({ code: 'not-actionable', detail: `this driver does not perform ${step.type} steps yet` });
    }
    // Anything this driver cannot perform in full is refused before it touches the page.
    const action = literalActionStep(step);
    if (action === undefined) return failure({ code: 'not-actionable', detail: `this driver does not perform this ${step.type} step yet` });
    // A secret reference arrives with the secret the engine resolved for it. Without that secret
    // there is nothing to type, and typing nothing could pass a step that should fail.
    const typed = action.type === 'fill' ? action.value : '';
    const typedSecret = typeof typed === 'string' ? null : secret?.name === typed.secretName ? secret : undefined;
    if (typedSecret === undefined) return failure({ code: 'not-actionable', detail: 'a secret reference reached the driver without its secret' });
    try {
      if (action.type === 'click') return await click(action.locator);
      const waited = await waitUntilActionable(operations, action.locator, environment.timeoutMilliseconds);
      if (!waited.ok) return waited;
      // The secret is revealed here, as it is typed, and nowhere else in this driver.
      if (action.type === 'fill') await operations.fill(waited.value.element, typedSecret === null ? String(typed) : reveal(typedSecret));
      else if (action.type === 'press') await operations.press(waited.value.element, action.key);
      return success(undefined);
    } catch (error) {
      return failure({ code: 'not-actionable', detail: errorText(error) });
    }
  };
  return {
    browser: details.browser,
    processId: details.processId,
    blockedOrigins: details.blockedOrigins,
    async navigate(url) {
      try {
        await operations.navigate(url, Math.max(environment.timeoutMilliseconds, 10_000));
        return success(undefined);
      } catch (error) {
        return failure({ code: 'navigation-failed', detail: errorText(error) });
      }
    },
    async page(): Promise<PageProbe> {
      return JSON.parse(await operations.callForString(pageInfo, [])) as PageProbe;
    },
    act,
    probe,
    async screenshot(mask) {
      await operations.callForString(fontsReady, []);
      await operations.callForString(maskElements, [mask]);
      try { return await operations.screenshotPng(); } finally { await operations.callForString(unmaskElements, []); }
    },
    async audit() {
      return toFindings(parseAudit(await operations.callForString(pageAudit, [])));
    },
    async auditDetailed() {
      return parseAudit(await operations.callForString(pageAudit, []));
    },
    accessibilitySnapshot: () => operations.accessibilityTree(),
    evaluate: (pageFunction: PageFunction, inputs = []) => operations.callForString(pageFunction, inputs),
    close: details.close,
  };
}
