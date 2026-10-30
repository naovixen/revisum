// Turns any protocol's PageOperations into a Session. Auto-waiting, the runtime guard, probing,
// masking and auditing live here once, so every protocol behaves the same way.
// See docs/specs/SPEC-06-cdp-driver.md.
import {
  DEFAULT_TEST_ID_ATTRIBUTE, DRIVER_FEATURES, failure, literalActionStep, literalText, performableLocator, reveal, success,
  type ActionGuard, type ActionStep, type BrowserRequestRecord, type DialogStep, type DocumentSession, type DriverError, type DriverFeature,
  type ElementProbe, type Locator, type PageProbe, type Position, type ResolvedActionStep, type ResolvedElement, type ResolvedLocator, type Result,
  type Secret, type SessionEnvironment,
} from '@revisum/contracts';
import {
  actionability, afterTwoFrames, armHitCheck, findByLabel, findByTestId, findByText, fontsReady, guardDetails, inDocumentOrder, inThisDocument,
  maskElements, pageInfo, probeElement, readHitCheck, selectOption, unmaskElements,
} from './in-page.ts';
import { heldModifierKeys } from './modifier-keys.ts';
import { pageAudit, parseAudit, toFindings, type AuditRuleResult } from './page-audit.ts';
import type { Actionability, DriverSession, PageEvents, PageFunction, PageOperations } from './page-operations.ts';

export const NO_ELEMENT: ElementProbe = { count: 0, visible: false, enabled: false, text: '', value: null, sensitive: false, box: null };
const POLL_INTERVAL_MILLISECONDS = 50;
// What the runtime guard is told for a dialog step, which acts on no element.
const NO_RESOLVED_ELEMENT: ResolvedElement = { role: null, name: null, box: null, formSubmitName: null, linkUrl: null };

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();
const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export type SessionDetails = {
  readonly browser: { readonly name: string; readonly version: string };
  readonly processId: number;
  readonly blockedOrigins: () => readonly string[];
  // Every request's origin and the channel it left the browser by.
  readonly egressRecords: () => readonly BrowserRequestRecord[];
  readonly close: () => Promise<void>;
  readonly events: PageEvents;
  // The absolute path of a declared upload fixture, or why it cannot be sent.
  readonly fixturePath: (fixture: string) => Result<string, DriverError>;
};

// The scheme of the page the browser shows in place of one it could not show.
const BROWSER_ERROR_PAGE = 'chrome-error:';

const CRASHED: DriverError = { code: 'target-crashed', detail: 'the page\'s renderer died' };

// The optional plan features every session buildSession makes performs, whatever its protocol:
// positions and test-id attributes in locate, chords and multi-line text in perform, and the
// probe a remember step reads through.
export const SESSION_FEATURES: readonly DriverFeature[] = DRIVER_FEATURES;

// Finds the elements a locator matches. An error while the page navigates counts as "nothing found yet".
export async function locate<Handle>(operations: PageOperations<Handle>, locator: ResolvedLocator): Promise<Handle[]> {
  try {
    const found = await matches(operations, locator);
    return locator.position === undefined ? found : await atPosition(operations, found, locator.position);
  } catch {
    return [];
  }
}

async function matches<Handle>(operations: PageOperations<Handle>, locator: ResolvedLocator): Promise<Handle[]> {
  switch (locator.by) {
    case 'role': return ownElements(operations, await operations.byRole(locator.role, locator.name));
    case 'label': return operations.callForElements(findByLabel, [locator.label]);
    case 'text': return operations.callForElements(findByText, [locator.text]);
    case 'testId': return operations.callForElements(findByTestId, [locator.testId, locator.attribute ?? DEFAULT_TEST_ID_ATTRIBUTE]);
  }
}

// The one match at the position, counted in document order, or none when there are fewer matches.
// The browser's accessibility search and the label search do not promise document order, so the
// matches are sorted in the page first.
async function atPosition<Handle>(operations: PageOperations<Handle>, found: readonly Handle[], position: Position): Promise<Handle[]> {
  const ordered = found.length < 2 ? [...found] : await operations.callForElements(inDocumentOrder, found.map((element) => ({ element })));
  const index = position === 'first' ? 0 : position === 'last' ? ordered.length - 1 : position - 1;
  const picked = ordered[index];
  return picked === undefined ? [] : [picked];
}

// The browser's accessibility search may reach into the frames of a document; a locator matches
// only the document it was given.
async function ownElements<Handle>(operations: PageOperations<Handle>, found: readonly Handle[]): Promise<Handle[]> {
  const own: Handle[] = [];
  for (const element of found) if (await operations.callForString(inThisDocument, [{ element }]) === 'yes') own.push(element);
  return own;
}

type Actionable<Handle> = Result<{ readonly element: Handle; readonly at: { x: number; y: number } }, DriverError>;
type Found<Handle> = Result<Handle, DriverError>;

const neverStops = (): boolean => false;

// Auto-wait: exactly one match that is attached, visible, stable, enabled and hit by a pointer at
// its centre. Never the first of several matches; a typed failure at the deadline, or at once when
// `crashed` says the page has died.
export async function waitUntilActionable<Handle>(
  operations: PageOperations<Handle>, locator: ResolvedLocator, timeoutMilliseconds: number, crashed: () => boolean = neverStops,
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
    if (crashed()) return failure(CRASHED);
    if (Date.now() >= deadline) break;
    await pause(POLL_INTERVAL_MILLISECONDS);
  }
  if (count === 0) return failure({ code: 'not-found', detail: `not-found after ${timeoutMilliseconds} ms` });
  if (count > 1) return failure({ code: 'ambiguous', detail: `${count} matches after ${timeoutMilliseconds} ms` });
  const lastCheck = last;
  const missing = lastCheck === null ? 'attached'
    : (['attached', 'visible', 'stable', 'enabled', 'receivesEvents'] as const).find((key) => !lastCheck[key]) ?? 'unknown';
  return failure({ code: 'not-actionable', detail: `not ${missing} after ${timeoutMilliseconds} ms` });
}

// Exactly one match, attached to the page: enough for setting a file input's files, which is
// often styled out of sight behind its label.
async function waitUntilFound<Handle>(
  operations: PageOperations<Handle>, locator: ResolvedLocator, timeoutMilliseconds: number, crashed: () => boolean,
): Promise<Found<Handle>> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const found = await locate(operations, locator);
    const element = found[0];
    if (found.length === 1 && element !== undefined) return success(element);
    if (crashed()) return failure(CRASHED);
    if (Date.now() >= deadline) {
      return found.length === 0
        ? failure({ code: 'not-found', detail: `not-found after ${timeoutMilliseconds} ms` })
        : failure({ code: 'ambiguous', detail: `${found.length} matches after ${timeoutMilliseconds} ms` });
    }
    await pause(POLL_INTERVAL_MILLISECONDS);
  }
}

// Decodes what guardDetails (in-page.ts) reports. A field of another shape is read as not shown.
function decodeGuardDetails(text: string): Omit<ResolvedElement, 'role' | 'name'> {
  const parsed: unknown = JSON.parse(text);
  const fields = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  const box = fields['box'];
  const boxFields = typeof box === 'object' && box !== null ? box as Record<string, unknown> : {};
  const [x, y, width, height] = [boxFields['x'], boxFields['y'], boxFields['width'], boxFields['height']];
  const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const testId = textOrNull(fields['testId']);
  return {
    box: typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number' ? { x, y, width, height } : null,
    formSubmitName: textOrNull(fields['formSubmitName']),
    linkUrl: textOrNull(fields['linkUrl']),
    ...(testId === null ? {} : { testId }),
  };
}

// The element as the runtime guard sees it.
async function resolvedElement<Handle>(operations: PageOperations<Handle>, element: Handle): Promise<ResolvedElement> {
  const { role, name } = await operations.roleAndName(element);
  return { role, name, ...decodeGuardDetails(await operations.callForString(guardDetails, [{ element }])) };
}

// Asks the guard, when there is one, about the resolved element. A denial is the step's error.
async function denial<Handle>(operations: PageOperations<Handle>, element: Handle, guard: ActionGuard | undefined): Promise<DriverError | null> {
  if (guard === undefined) return null;
  const verdict = guard(await resolvedElement(operations, element), null);
  return verdict.kind === 'deny' ? { code: 'policy-denied', detail: `denied by the ${verdict.rule} rule` } : null;
}

type DocumentPorts = DocumentSession & { auditDetailed(): Promise<readonly AuditRuleResult[]> };

// The text a fill of literal text or of lines types; a secret reference is revealed elsewhere.
const textToFill = (value: Extract<ResolvedActionStep, { type: 'fill' }>['value']): string =>
  (typeof value === 'string' ? value : 'lines' in value ? value.lines.join('\n') : '');

// The ports of one document. `masked` lists the documents a screenshot masks: this one and every
// document it is framed in, so a capture from inside a frame hides what the top page hides.
function documentPorts<Handle>(
  operations: PageOperations<Handle>, masked: readonly PageOperations<Handle>[], environment: SessionEnvironment, details: SessionDetails,
): DocumentPorts {
  const events = details.events;
  const crashed = (): boolean => events.crashed();
  const timeout = environment.timeoutMilliseconds;

  const probe = async (planLocator: Locator): Promise<ElementProbe> => {
    // A value reference, or a locator this session cannot resolve, matches nothing.
    const locator = performableLocator(planLocator, SESSION_FEATURES);
    // An open dialog stops the page's scripts, so nothing can be read until it is answered.
    if (locator === undefined || events.openDialog() !== null) return NO_ELEMENT;
    const found = await locate(operations, locator);
    const element = found[0];
    if (found.length !== 1 || element === undefined) return { ...NO_ELEMENT, count: found.length };
    try {
      return JSON.parse(await operations.callForString(probeElement, [{ element }, environment.sensitiveSelectors])) as ElementProbe;
    } catch {
      return NO_ELEMENT;
    }
  };

  // A click with a hit-target check: a click that lands on another element is swallowed in the
  // page and retried. The guard is asked once, about the element first found ready.
  const click = async (locator: ResolvedLocator, guard: ActionGuard | undefined): Promise<Result<void, DriverError>> => {
    const deadline = Date.now() + timeout;
    let asked = false;
    for (;;) {
      const waited = await waitUntilActionable(operations, locator, Math.max(deadline - Date.now(), 0), crashed);
      if (!waited.ok) return waited;
      if (!asked) {
        asked = true;
        const denied = await denial(operations, waited.value.element, guard);
        if (denied !== null) return failure(denied);
      }
      await operations.callForString(armHitCheck, [{ element: waited.value.element }]);
      await operations.click(waited.value.element, waited.value.at);
      // A dialog the click opened stops the page until it is answered: the click landed.
      if (events.openDialog() !== null) return success(undefined);
      let hit = 'hit';
      try { hit = await operations.callForString(readHitCheck, []); } catch { /* the click navigated, so it landed */ }
      if (hit !== 'miss') return success(undefined);
      if (Date.now() >= deadline) {
        return failure({ code: 'not-actionable', detail: `click landed on another element until ${timeout} ms` });
      }
    }
  };

  // The action itself, once the step is known to be performable.
  const perform = async (action: ResolvedActionStep, guard: ActionGuard | undefined, typedSecret: Secret | null): Promise<Result<void, DriverError>> => {
    if (action.type === 'click') return click(action.locator, guard);
    if (action.type === 'upload') {
      const path = details.fixturePath(action.fixture);
      if (!path.ok) return path;
      const found = await waitUntilFound(operations, action.locator, timeout, crashed);
      if (!found.ok) return found;
      const denied = await denial(operations, found.value, guard);
      if (denied !== null) return failure(denied);
      await operations.setFiles(found.value, [path.value]);
      return success(undefined);
    }
    const waited = await waitUntilActionable(operations, action.locator, timeout, crashed);
    if (!waited.ok) return waited;
    const { element, at } = waited.value;
    const denied = await denial(operations, element, guard);
    if (denied !== null) return failure(denied);
    switch (action.type) {
      case 'hover': await operations.hover(at); break;
      // The secret is revealed here, as it is typed, and nowhere else in this driver. Lines are
      // joined by line feeds and inserted as text, so no Enter key press can send a form early.
      case 'fill': await operations.fill(element, typedSecret === null ? textToFill(action.value) : reveal(typedSecret)); break;
      case 'press': await operations.press(element, action.key, heldModifierKeys(action.modifiers ?? [], process.platform)); break;
      case 'select': {
        const chosen = await operations.callForString(selectOption, [{ element }, action.option]);
        if (chosen === 'no-option') return failure({ code: 'not-found', detail: 'the select has no option with that text or value' });
        if (chosen !== 'selected') return failure({ code: 'not-actionable', detail: 'the element is not a select' });
        break;
      }
    }
    return success(undefined);
  };

  // Answers the dialog the page has open, or opens within the timeout: its text is checked first,
  // then the guard is asked with it.
  const answerDialog = async (step: DialogStep, guard: ActionGuard | undefined): Promise<Result<void, DriverError>> => {
    const deadline = Date.now() + timeout;
    let text = events.openDialog();
    while (text === null) {
      if (crashed()) return failure(CRASHED);
      if (Date.now() >= deadline) return failure({ code: 'not-found', detail: `no dialog opened within ${timeout} ms` });
      await pause(POLL_INTERVAL_MILLISECONDS);
      text = events.openDialog();
    }
    if (step.expectText !== undefined) {
      const expected = literalText(step.expectText);
      if (expected === undefined) return failure({ code: 'unsupported-step', detail: 'a value reference reached the driver' });
      // The dialog's text is never echoed: it may hold personal data.
      if (normalise(expected) !== normalise(text)) return failure({ code: 'assertion-failed', detail: 'the open dialog does not say the expected text' });
    }
    const verdict = guard?.(NO_RESOLVED_ELEMENT, text);
    if (verdict?.kind === 'deny') return failure({ code: 'policy-denied', detail: `denied by the ${verdict.rule} rule` });
    await events.answerDialog(step.action === 'accept');
    return success(undefined);
  };

  const act = async (step: ActionStep, guard?: ActionGuard, secret?: Secret): Promise<Result<void, DriverError>> => {
    if (crashed()) return failure(CRASHED);
    if (step.type === 'dialog') {
      try { return await answerDialog(step, guard); } catch (error) { return failure(crashed() ? CRASHED : { code: 'not-actionable', detail: errorText(error) }); }
    }
    if (events.openDialog() !== null) return failure({ code: 'not-actionable', detail: 'a dialog is open: a dialog step must answer it first' });
    // Anything this driver cannot perform in full is refused before it touches the page.
    const action = literalActionStep(step, SESSION_FEATURES);
    if (action === undefined) return failure({ code: 'unsupported-step', detail: `this driver does not perform this ${step.type} step yet` });
    // A secret reference arrives with the secret the engine resolved for it. Without that secret
    // there is nothing to type, and typing nothing could pass a step that should fail.
    const typed = action.type === 'fill' ? action.value : '';
    const typedSecret = typeof typed === 'string' || 'lines' in typed ? null : secret?.name === typed.secretName ? secret : undefined;
    if (typedSecret === undefined) return failure({ code: 'not-actionable', detail: 'a secret reference reached the driver without its secret' });
    const openingsBefore = events.unsupportedOpenings();
    let acted: Result<void, DriverError>;
    try {
      acted = await perform(action, guard, typedSecret);
    } catch (error) {
      acted = failure({ code: 'not-actionable', detail: errorText(error) });
    }
    // Whatever the action started reaches the browser within a frame or two; then the driver looks.
    if (acted.ok && events.openDialog() === null) {
      try { await operations.callForString(afterTwoFrames, []); } catch { /* the page navigated or died: looked at below */ }
    }
    if (crashed()) return failure(CRASHED);
    if (events.unsupportedOpenings() > openingsBefore) {
      return failure({ code: 'unsupported-step', detail: 'the step opened a popup or a second page, or started a download' });
    }
    return acted;
  };

  const ports: DocumentPorts = {
    async navigate(url) {
      if (crashed()) return failure(CRASHED);
      try {
        await operations.navigate(url, Math.max(timeout, 10_000));
        return success(undefined);
      } catch (error) {
        return failure(crashed() ? CRASHED : { code: 'navigation-failed', detail: errorText(error) });
      }
    },
    async page(): Promise<PageProbe> {
      const shown = JSON.parse(await operations.callForString(pageInfo, [])) as PageProbe;
      // In place of a page it could not show, the browser shows its own error page at an internal
      // URL; the page's URL is still the one navigated to, as the address bar shows.
      if (!shown.url.startsWith(BROWSER_ERROR_PAGE)) return shown;
      return { ...shown, url: await operations.unreachableUrl() ?? shown.url };
    },
    act,
    probe,
    async screenshot(mask) {
      await operations.callForString(fontsReady, []);
      for (const framed of masked) await framed.callForString(maskElements, [mask]);
      try {
        return await operations.screenshotPng();
      } finally {
        for (const framed of masked) await framed.callForString(unmaskElements, []);
      }
    },
    async audit() {
      return toFindings(parseAudit(await operations.callForString(pageAudit, [])));
    },
    async auditDetailed() {
      return parseAudit(await operations.callForString(pageAudit, []));
    },
    accessibilitySnapshot: () => operations.accessibilityTree(),
    async frame(locator) {
      if (crashed()) return failure(CRASHED);
      const found = await waitUntilFound(operations, locator, timeout, crashed);
      if (!found.ok) return found;
      let inner: PageOperations<Handle> | null;
      try {
        inner = await operations.frame(found.value);
      } catch (error) {
        return failure(crashed() ? CRASHED : { code: 'not-actionable', detail: errorText(error) });
      }
      // An element that is no iframe, or an iframe whose document runs in another process.
      if (inner === null) return failure({ code: 'unsupported-step', detail: 'the element is not an iframe whose document this driver can reach' });
      return success(documentPorts(inner, [...masked, inner], environment, details));
    },
    crashed,
  };
  return ports;
}

export function buildSession<Handle>(operations: PageOperations<Handle>, environment: SessionEnvironment, details: SessionDetails): DriverSession {
  return {
    ...documentPorts(operations, [operations], environment, details),
    browser: details.browser,
    processId: details.processId,
    blockedOrigins: details.blockedOrigins,
    egressRecords: details.egressRecords,
    evaluate: (pageFunction: PageFunction, inputs = []) => operations.callForString(pageFunction, inputs),
    close: details.close,
  };
}
