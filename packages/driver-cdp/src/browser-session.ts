// Turns any protocol's PageOperations into a Session. Auto-waiting, the runtime guard, probing,
// masking and auditing live here once, so every protocol behaves the same way.
// See docs/specs/SPEC-06-cdp-driver.md, and docs/specs/SPEC-36-unsafe-plan-features.md for CSS
// and XPath locators, DOM reads and page scripts.
import {
  DEFAULT_TEST_ID_ATTRIBUTE, DRIVER_FEATURES, failure, literalActionStep, literalText, performableLocator, reveal, success,
  type ActionGuard, type ActionStep, type BrowserRequestRecord, type DialogStep, type DocumentSession, type DomRead, type DomValue, type DownloadedFile,
  type DownloadStep, type DriverError, type DriverFeature, type ElementProbe, type Locator, type PageScriptCall, type PageMetaTag, type PageProbe, type Position, type ResolvedActionStep,
  type ClipboardPort, type ClockPort, type NetworkPort, type ResolvedElement, type ResolvedLocator, type Result, type Secret, type SessionEnvironment, type StoragePort,
} from '@revisum/contracts';
import {
  actionability, afterTwoFrames, armHitCheck, findByLabel, findByTestId, findByText, findStructural, fontsReady, guardDetails, inDocumentOrder,
  inThisDocument, linkAndCurrent, maskElements, pageInfo, probeElement, readDomValue, readHitCheck, selectOption, structuralSelectorValidity,
  unmaskElements,
} from './in-page.ts';
import { heldModifierKeys } from './modifier-keys.ts';
import { pageAudit, parseAudit, toFindings, type AuditRuleResult } from './page-audit.ts';
import type { Actionability, DownloadCapture, DriverSession, PageEvents, PageFunction, PageOperations } from './page-operations.ts';

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
  // Where a download step's file is saved. Without it, the session refuses download steps.
  readonly downloads?: DownloadCapture;
  // Opens a second tab of the session's browser context, still on about:blank. Without it, the
  // session opens no tabs.
  readonly openTab?: () => Promise<Result<DriverSession, DriverError>>;
  // Stubs and request checks for the whole browser context. Without it, the session has none.
  readonly network?: NetworkPort;
  // The page's local and session storage. Without it, the session has none.
  readonly storage?: StoragePort;
  // The session's virtual clock, shared by every tab. Without it, the session advances no clock.
  readonly clock?: ClockPort;
  // The browser's own clipboard. Without it, the session reads no clipboard.
  readonly clipboard?: ClipboardPort;
};

// The scheme of the page the browser shows in place of one it could not show.
const BROWSER_ERROR_PAGE = 'chrome-error:';

const CRASHED: DriverError = { code: 'target-crashed', detail: 'the page\'s renderer died' };
const SELECTOR_INVALID: DriverError = { code: 'selector-invalid', detail: 'the browser rejects a CSS selector or XPath expression of the locator' };

// The optional plan features every session buildSession makes performs, whatever its protocol:
// positions, test-id attributes and CSS and XPath selectors in locate, chords and multi-line text
// in perform, the probe a remember step and a DOM check read through, and the script runner.
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
    case 'css': case 'xpath': {
      // Inside another locator, the selector is evaluated in the one element that one finds, or nowhere.
      const scope = locator.inside === undefined ? [] : await locate(operations, locator.inside);
      if (locator.inside !== undefined && scope.length !== 1) return [];
      const text = locator.by === 'css' ? locator.selector : locator.expression;
      return operations.callForElements(findStructural, [locator.by, text, locator.hasText ?? '', ...scope.map((element) => ({ element }))]);
    }
  }
}

// True when the browser rejects a CSS selector or XPath expression of the locator or of a locator
// it is inside. A page that cannot answer, such as one navigating, is taken to accept it: matching
// then finds nothing yet, as for any locator.
async function rejectsSelector<Handle>(operations: PageOperations<Handle>, locator: ResolvedLocator): Promise<boolean> {
  if (locator.by !== 'css' && locator.by !== 'xpath') return false;
  const text = locator.by === 'css' ? locator.selector : locator.expression;
  let validity = 'valid';
  try { validity = await operations.callForString(structuralSelectorValidity, [locator.by, text]); } catch { /* taken as accepted */ }
  if (validity === 'invalid') return true;
  return locator.inside !== undefined && rejectsSelector(operations, locator.inside);
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

// Decodes what linkAndCurrent (in-page.ts) reports. A field of another shape is read as not shown.
function decodeLinkAndCurrent(text: string): { readonly href: string | null; readonly current: boolean | null } {
  const parsed: unknown = JSON.parse(text);
  const fields = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  const href = fields['href'];
  const current = fields['current'];
  return { href: typeof href === 'string' ? href : null, current: current === 'true' ? true : current === 'false' ? false : null };
}

// Decodes what pageInfo (in-page.ts) reports. The page's own scripts may have changed what the
// browser hands back, so every field is checked; a meta tag of another shape is left out.
function decodePageInfo(text: string): PageProbe {
  const parsed: unknown = JSON.parse(text);
  const fields = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  const [url, title, meta, canonicalUrl] = [fields['url'], fields['title'], fields['meta'], fields['canonicalUrl']];
  if (typeof url !== 'string' || typeof title !== 'string') throw new Error('the page did not report its URL and title');
  const tags: PageMetaTag[] = [];
  for (const tag of Array.isArray(meta) ? meta : []) {
    const tagFields = typeof tag === 'object' && tag !== null ? tag as Record<string, unknown> : {};
    const [name, content] = [tagFields['name'], tagFields['content']];
    if (typeof name === 'string' && typeof content === 'string') tags.push({ name, content });
  }
  return { url, title, meta: tags, canonicalUrl: typeof canonicalUrl === 'string' ? canonicalUrl : null };
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

// The style property or attribute a DOM read names; empty for the class list.
const domReadName = (read: DomRead): string => (read.kind === 'computedStyle' ? read.property : read.kind === 'attribute' ? read.name : '');

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
// document it is framed in, so a capture from inside a frame hides what the top page hides. The
// first of them is the top document.
function documentPorts<Handle>(
  operations: PageOperations<Handle>, masked: readonly PageOperations<Handle>[], environment: SessionEnvironment, details: SessionDetails,
): DocumentPorts {
  const isTopDocument = masked.length === 1;
  const events = details.events;
  const crashed = (): boolean => events.crashed();
  const timeout = environment.timeoutMilliseconds;

  const probe = async (planLocator: Locator, read?: DomRead): Promise<ElementProbe> => {
    // A value reference, or a locator this session cannot resolve, matches nothing.
    const locator = performableLocator(planLocator, SESSION_FEATURES);
    // An open dialog stops the page's scripts, so nothing can be read until it is answered.
    if (locator === undefined || events.openDialog() !== null) return NO_ELEMENT;
    if (await rejectsSelector(operations, locator)) return { ...NO_ELEMENT, selectorInvalid: true };
    const found = await locate(operations, locator);
    const element = found[0];
    if (found.length !== 1 || element === undefined) return { ...NO_ELEMENT, count: found.length };
    try {
      const shown = JSON.parse(await operations.callForString(probeElement, [{ element }, environment.sensitiveSelectors])) as ElementProbe;
      // The link target and aria-current come from the document, the other states from the
      // browser's accessibility engine, as assistive technology reads them.
      const { href, current } = decodeLinkAndCurrent(await operations.callForString(linkAndCurrent, [{ element }]));
      const exposed = await operations.exposedStates(element);
      // A DOM check's read: a class list, a computed style or an attribute, read from the document.
      const dom = read === undefined ? undefined : decodeDomValue(await operations.callForString(readDomValue, [{ element }, read.kind, domReadName(read)]), read);
      return { ...shown, states: { ...exposed, current }, href, ...(dom === undefined ? {} : { dom }) };
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
    if (await rejectsSelector(operations, action.locator)) return failure(SELECTOR_INVALID);
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

  // A download step: the click, guarded as any click, with the browser armed to save the one
  // download it starts. A popup the click opens, or a second download, fails the step with
  // unsupported-step and nothing of it is kept.
  const download = async (step: DownloadStep, maximumBytes: number, guard?: ActionGuard): Promise<Result<DownloadedFile, DriverError>> => {
    if (crashed()) return failure(CRASHED);
    const capture = details.downloads;
    const locator = performableLocator(step.locator, SESSION_FEATURES);
    if (capture === undefined || locator === undefined) return failure({ code: 'unsupported-step', detail: 'this driver does not perform this download step' });
    if (await rejectsSelector(operations, locator)) return failure(SELECTOR_INVALID);
    if (events.openDialog() !== null) return failure({ code: 'not-actionable', detail: 'a dialog is open: a dialog step must answer it first' });
    const openingsBefore = events.unsupportedOpenings();
    const armed = await capture.arm();
    let kept = false;
    try {
      const clicked = await act({ type: 'click', locator }, guard);
      if (!clicked.ok) return clicked;
      const saved = await armed.finish(maximumBytes, timeout);
      if (crashed()) return failure(CRASHED);
      if (events.unsupportedOpenings() > openingsBefore) {
        return failure({ code: 'unsupported-step', detail: 'the click opened a popup or a second page, or started a second download' });
      }
      kept = saved.ok;
      return saved;
    } finally {
      await armed.release(kept);
    }
  };

  // A page script, raced against its timeout in real time. A script that never settles is left to
  // the page: the run ends without it, and closing the session ends the page.
  const runScript = async (call: PageScriptCall): Promise<Result<string, DriverError>> => {
    if (crashed()) return failure(CRASHED);
    if (events.openDialog() !== null) return failure({ code: 'not-actionable', detail: 'a dialog is open: a dialog step must answer it first' });
    const openingsBefore = events.unsupportedOpenings();
    const called = operations.callScript(call.source, call.arguments, call.maximumResultBytes);
    called.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timed-out'>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout('timed-out'), call.timeoutMilliseconds); });
    let ended: Awaited<typeof called> | 'timed-out';
    try {
      ended = await Promise.race([called, timedOut]);
    } catch (error) {
      return failure(crashed() ? CRASHED : { code: 'script-failed', detail: errorText(error) });
    } finally {
      clearTimeout(timer);
    }
    if (crashed()) return failure(CRASHED);
    if (ended === 'timed-out') return failure({ code: 'script-timeout', detail: `the script did not settle within ${call.timeoutMilliseconds} ms` });
    // A popup, second page or download the script started is closed or cancelled, as for an action.
    if (events.unsupportedOpenings() > openingsBefore) {
      return failure({ code: 'unsupported-step', detail: 'the script opened a popup or a second page, or started a download' });
    }
    switch (ended.kind) {
      case 'result': return success(ended.text);
      case 'threw': return failure({ code: 'script-failed', detail: 'the script threw or its promise was rejected' });
      case 'not-json': return failure({ code: 'script-result-invalid', detail: 'the script\'s result is not a value JSON can write' });
    }
  };

  const ports: DocumentPorts = {
    async navigate(url, options) {
      if (crashed()) return failure(CRASHED);
      const scripts = options?.scripts ?? 'enabled';
      // Scripts are a setting of the whole page, so only the top document's navigate turns them off.
      if (scripts === 'disabled' && !isTopDocument) return failure({ code: 'unsupported-step', detail: 'scripts can be turned off only for the top document' });
      try {
        await operations.navigate(url, Math.max(timeout, 10_000), scripts);
        return success(undefined);
      } catch (error) {
        return failure(crashed() ? CRASHED : { code: 'navigation-failed', detail: errorText(error) });
      }
    },
    async page(): Promise<PageProbe> {
      const shown = decodePageInfo(await operations.callForString(pageInfo, []));
      // In place of a page it could not show, the browser shows its own error page at an internal
      // URL; the page's URL is still the one navigated to, as the address bar shows.
      if (!shown.url.startsWith(BROWSER_ERROR_PAGE)) return shown;
      return { ...shown, url: await operations.unreachableUrl() ?? shown.url };
    },
    act,
    probe,
    download,
    runScript,
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
      if (await rejectsSelector(operations, locator)) return failure(SELECTOR_INVALID);
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

// Opens a second tab and loads the URL in it. A tab whose page does not load is closed at once.
async function newTabAt(openTab: () => Promise<Result<DriverSession, DriverError>>, url: string): Promise<Result<DriverSession, DriverError>> {
  const opened = await openTab();
  if (!opened.ok) return opened;
  const tab = opened.value;
  const navigated = await tab.navigate(url);
  if (navigated.ok) return success(tab);
  await tab.close();
  return navigated;
}

export function buildSession<Handle>(operations: PageOperations<Handle>, environment: SessionEnvironment, details: SessionDetails): DriverSession {
  const openTab = details.openTab;
  return {
    ...documentPorts(operations, [operations], environment, details),
    ...(openTab === undefined ? {} : { newTab: (url: string) => newTabAt(openTab, url) }),
    ...(details.network === undefined ? {} : { network: details.network }),
    ...(details.storage === undefined ? {} : { storage: details.storage }),
    ...(details.clock === undefined ? {} : { clock: details.clock }),
    ...(details.clipboard === undefined ? {} : { clipboard: details.clipboard }),
    browser: details.browser,
    processId: details.processId,
    blockedOrigins: details.blockedOrigins,
    egressRecords: details.egressRecords,
    evaluate: (pageFunction: PageFunction, inputs = []) => operations.callForString(pageFunction, inputs),
    close: details.close,
  };
}
