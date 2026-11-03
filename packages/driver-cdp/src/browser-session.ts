// Turns any protocol's PageOperations into a Session. Auto-waiting, the runtime guard, probing,
// masking and auditing live here once, so every protocol behaves the same way.
// for css
// and XPath locators, DOM reads and page scripts.
import { isDeepStrictEqual } from 'node:util';
import {
  DEFAULT_TEST_ID_ATTRIBUTE, DRIVER_FEATURES, failure, literalActionStep, literalText, performableLocator, reveal, success,
  type ActionGuard, type ActionStep, type BrowserRequestRecord, type DialogStep, type DocumentSession, type DomRead, type DomValue, type DownloadedFile,
  type DownloadStep, type DriverError, type DriverFeature, type ElementProbe, type Locator, type PageScriptCall, type PageMetaTag, type PageProbe, type Position, type ResolvedActionStep,
  type ClipboardPort, type ClockPort, type GuardVerdict, type NetworkPort, type ResolvedElement, type ResolvedLocator, type Result, type Secret, type SessionEnvironment, type StoragePort,
  UnreadablePage,
} from '@revisum/contracts';
import {
  actionability, armHitCheck, documentUrl, fieldValues, fontsReady, guardDetails, inThisDocument, linkAndCurrent, linkTargetList, maskElements, maskGivenElements, pageInfo, probeElement, readDomValue, readHitCheck, selectOption,
  structuralSelectorValidity, unmaskElements, whatAClickActivates,
} from './in-page.ts';
import { findByLabel, findByTestId, findByText, findStructural, inDocumentOrder } from './FindByLabel.ts';
import { heldModifierKeys } from './modifier-keys.ts';
import { pageAudit, parseAudit, toFindings } from './page-audit.ts';
import type { Actionability, DownloadCapture, DriverSession, PageEvents, PageFunction, PageOperations, Point, ScriptCallOutcome } from './page-operations.ts';
import { PageHeldByDialog } from './PageHeldByDialog.ts';
import type { ConnectionFailure } from './SessionEgress.ts';

const NOTHING_READ = { visible: false, enabled: false, text: '', value: null, sensitive: false, box: null } as const;
const READ_FAILED: ElementProbe = { ...NOTHING_READ, count: UnreadablePage.ReadFailed };
const DIALOG_HOLDS_PAGE: ElementProbe = { ...NOTHING_READ, count: UnreadablePage.DialogOpen };
const ON_BROWSER_ERROR_PAGE: ElementProbe = { ...NOTHING_READ, count: UnreadablePage.BrowserErrorPage };
const POLL_INTERVAL_MILLISECONDS = 50;
const TIMED_OUT = Symbol('timed out');
// What the runtime guard is told for a dialog step, which acts on no element.
const NO_RESOLVED_ELEMENT: ResolvedElement = { role: null, name: null, box: null, formSubmitName: null, linkUrl: null };

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();
const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Waits for what the page was asked for at most this long. While a navigation of the page waits for
// its server, the browser answers no command to that page, and nor does the mouse release that began
// it, so a server that holds its answer would otherwise hold the step for as long as a command's own
// limit, however short the step's timeout. What was asked for is left to end by itself.
async function forAtMost<Value>(milliseconds: number, work: Promise<Value>): Promise<Value | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolveTimedOut) => { timer = setTimeout(() => resolveTimedOut(TIMED_OUT), milliseconds); });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// Lets a catch that reads a failed look at the page as "nothing yet" keep to failures that can pass.
function rethrowIfHeldByDialog(error: unknown): void {
  if (error instanceof PageHeldByDialog) {
    throw error;
  }
}

const notAnswering = (timeoutMilliseconds: number): DriverError => ({ code: 'timeout', detail: `the page did not answer within ${timeoutMilliseconds} ms` });

// What a page is asked for at most this long, or the failure to answer. Throws, as a read of the page
// that fails does: the run's step says the page could not be read.
async function answeredWithin<Value>(milliseconds: number, work: Promise<Value>): Promise<Value> {
  const answered = await forAtMost(milliseconds, work);
  if (answered === TIMED_OUT) {
    throw new Error(notAnswering(milliseconds).detail);
  }
  return answered;
}

// However late an element was found, its input gets this long, or the input could never be seen to
// land. So a step ends within about its timeout and this, never twice its timeout.
const SHORTEST_INPUT_MILLISECONDS = 1_000;

// A field a secret was typed into: the locator that found it, and whether that very element has gone.
export type SecretTypedField = { readonly locator: ResolvedLocator; readonly isGone: () => Promise<boolean> };

export type SessionDetails = {
  readonly browser: { readonly name: string; readonly version: string };
  readonly processId: number;
  readonly blockedOrigins: () => readonly string[];
  readonly connectionFailures: () => readonly ConnectionFailure[];
  // Every request's origin and the channel it left the browser by.
  readonly egressRecords: () => readonly BrowserRequestRecord[];
  readonly close: () => Promise<void>;
  readonly events: PageEvents;
  // The absolute path of a declared upload fixture, or why it cannot be sent.
  readonly fixturePath: (fixture: string) => Result<string, DriverError>;
  // Where a download step's file is saved. Without it, the session refuses download steps.
  readonly downloads?: DownloadCapture;
  // Every field the session and its tabs have typed a secret into, in the order they were typed.
  readonly secretTypedFields: SecretTypedField[];
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
const DIALOG_OPEN: DriverError = { code: 'dialog-open', detail: 'a dialog is open: a dialog step must answer it first' };
const SELECTOR_INVALID: DriverError = { code: 'selector-invalid', detail: 'the browser rejects a CSS selector or XPath expression of the locator' };
const NO_GUARD: DriverError = { code: 'policy-denied', detail: 'no runtime guard was given, so nothing can allow the action' };

// The optional plan features every session buildSession makes performs, whatever its protocol:
// positions, test-id attributes and css and XPath selectors in locate, chords and multi-line text
// in perform, the probe a remember step and a DOM check read through, and the script runner.
export const SESSION_FEATURES: readonly DriverFeature[] = DRIVER_FEATURES;

// The elements a locator matches. Throws when the page cannot answer, which says nothing about
// what is on it.
async function findElements<Handle>(operations: PageOperations<Handle>, locator: ResolvedLocator): Promise<Handle[]> {
  const found = await matches(operations, locator);
  return locator.position === undefined ? found : atPosition(operations, found, locator.position);
}

// For an action, which only waits for an element to act on: an error while the page navigates
// counts as "nothing found yet". A check reads through findElements, since finding nothing can pass it.
async function locate<Handle>(operations: PageOperations<Handle>, locator: ResolvedLocator): Promise<Handle[]> {
  try {
    return await findElements(operations, locator);
  } catch (error) {
    rethrowIfHeldByDialog(error);
    return [];
  }
}

async function matches<Handle>(operations: PageOperations<Handle>, locator: ResolvedLocator): Promise<Handle[]> {
  switch (locator.by) {
    // The browser compares names with their white space collapsed, so a plan's name must be too.
    case 'role': return ownElements(operations, await operations.byRole(locator.role, normalise(locator.name)));
    case 'label': return operations.callForElements(findByLabel, [locator.label]);
    case 'text': return operations.callForElements(findByText, [locator.text]);
    case 'testId': return operations.callForElements(findByTestId, [locator.testId, locator.attribute ?? DEFAULT_TEST_ID_ATTRIBUTE]);
    case 'css': case 'xpath': {
      // Inside another locator, the selector is evaluated in the one element that one finds, or nowhere.
      const scope = locator.inside === undefined ? [] : await findElements(operations, locator.inside);
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
  try {
    validity = await operations.callForString(structuralSelectorValidity, [locator.by, text]);
  } catch (error) {
    rethrowIfHeldByDialog(error);
  }
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

type ActionabilityLook<Handle> = { readonly count: number; readonly element?: Handle; readonly check: Actionability | null };

async function lookForActionable<Handle>(operations: PageOperations<Handle>, locator: ResolvedLocator): Promise<ActionabilityLook<Handle>> {
  const found = await locate(operations, locator);
  const element = found[0];
  if (found.length !== 1 || element === undefined) {
    return { count: found.length, check: null };
  }
  try {
    return { count: 1, element, check: JSON.parse(await operations.callForString(actionability, [{ element }])) as Actionability };
  } catch (error) {
    rethrowIfHeldByDialog(error);
    return { count: 1, check: null }; // detached during the check: locate again
  }
}

const REQUIRED_STATES = ['attached', 'visible', 'stable', 'enabled', 'receivesEvents'] as const;

function whyNotActionable<Handle>(look: ActionabilityLook<Handle>, timeoutMilliseconds: number): DriverError {
  if (look.count === 0) {
    return { code: 'not-found', detail: `not-found after ${timeoutMilliseconds} ms` };
  }
  if (look.count > 1) {
    return { code: 'ambiguous', detail: `${look.count} matches after ${timeoutMilliseconds} ms` };
  }
  const check = look.check;
  const missing = check === null ? 'attached' : REQUIRED_STATES.find((state) => !check[state]) ?? 'unknown';
  return { code: 'not-actionable', detail: `not ${missing} after ${timeoutMilliseconds} ms` };
}

// Auto-wait: exactly one match that is attached, visible, stable, enabled and hit by a pointer at
// its centre. Never the first of several matches; a typed failure at the deadline, or at once when
// `crashed` says the page has died. One look gets the whole of `lookLimitMilliseconds`, however
// little of the wait is left, so only a page that has stopped answering fails with timeout.
async function waitUntilActionable<Handle>(
  operations: PageOperations<Handle>, locator: ResolvedLocator, timeoutMilliseconds: number, lookLimitMilliseconds: number, crashed: () => boolean,
): Promise<Actionable<Handle>> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const look = await forAtMost(lookLimitMilliseconds, lookForActionable(operations, locator));
    if (look === TIMED_OUT) {
      return failure(notAnswering(lookLimitMilliseconds));
    }
    const centre = look.check?.centre ?? null;
    if (look.element !== undefined && centre !== null && REQUIRED_STATES.every((state) => look.check?.[state] === true)) {
      return success({ element: look.element, at: centre });
    }
    if (crashed()) {
      return failure(CRASHED);
    }
    if (Date.now() >= deadline) {
      return failure(whyNotActionable(look, timeoutMilliseconds));
    }
    await pause(POLL_INTERVAL_MILLISECONDS);
  }
}

// Exactly one match, attached to the page: enough for setting a file input's files, which is
// often styled out of sight behind its label.
async function waitUntilFound<Handle>(
  operations: PageOperations<Handle>, locator: ResolvedLocator, timeoutMilliseconds: number, crashed: () => boolean,
): Promise<Found<Handle>> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const found = await forAtMost(timeoutMilliseconds, locate(operations, locator));
    if (found === TIMED_OUT) {
      return failure(notAnswering(timeoutMilliseconds));
    }
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

// Decodes what linkTargetList (in-page.ts) reports. The page's own scripts may have changed what the
// browser hands back, so an entry that is not text is left out.
function decodeLinkTargets(text: string): readonly string[] {
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed.filter((target): target is string => typeof target === 'string') : [];
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

// A denial as the step's error, or null for an allow.
function denialOf(verdict: GuardVerdict): DriverError | null {
  return verdict.kind === 'deny' ? { code: 'policy-denied', detail: `denied by the ${verdict.rule} rule` } : null;
}

// Asks the guard about the resolved element. A denial is the step's error.
async function denial<Handle>(operations: PageOperations<Handle>, element: Handle, guard: ActionGuard): Promise<DriverError | null> {
  return denialOf(guard(await resolvedElement(operations, element), null));
}

const isUnnamed = (element: ResolvedElement): boolean => element.name === null || element.name.trim() === '';

// Asks the guard about a click at the point: the element found, then what the click would really
// act on, since a press goes to whatever is under the pointer and on to the control around it. A
// wrapper's or an icon's harmless name must not stand in for that control's. Most of what a pointer
// lands on has no name of its own, which says nothing against the plan's element, so such an
// element is judged only on the link it leads to, under the name of the element found.
async function clickDenial<Handle>(operations: PageOperations<Handle>, element: Handle, at: Point, guard: ActionGuard): Promise<DriverError | null> {
  const found = await resolvedElement(operations, element);
  const denied = denialOf(guard(found, null));
  if (denied !== null) {
    return denied;
  }
  for (const activated of await operations.callForElements(whatAClickActivates, [{ element }, at.x, at.y])) {
    const seen = await resolvedElement(operations, activated);
    if (isUnnamed(seen) && (seen.linkUrl === null || seen.linkUrl === found.linkUrl)) {
      continue;
    }
    const activatedDenial = denialOf(guard(isUnnamed(seen) ? { ...found, linkUrl: seen.linkUrl } : seen, null));
    if (activatedDenial !== null) {
      return activatedDenial;
    }
  }
  return null;
}

// True when every element a secret was typed into under this locator has gone. One the session has
// no record of, or one that cannot say, counts as still there.
async function hasTypedFieldGone(typedFields: readonly SecretTypedField[], locator: ResolvedLocator): Promise<boolean> {
  const typed = typedFields.filter((field) => isDeepStrictEqual(field.locator, locator));
  try {
    const gone = await Promise.all(typed.map((field) => field.isGone()));
    return typed.length > 0 && gone.every(Boolean);
  } catch {
    return false;
  }
}

// Decodes what fieldValues (in-page.ts) reports. A page's own scripts may have changed what the
// browser hands back, so a list of another shape throws, and that shows nothing either way.
function decodeFieldValues(text: string): readonly string[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new TypeError('the page did not report its fields as a list');
  }
  return parsed.filter((value): value is string => typeof value === 'string');
}

// True when some field in the documents holds a secret: a page may render a field afresh under another
// label, still holding what was typed, and no locator finds that one.
async function hasFieldHoldingASecret<Handle>(documents: readonly PageOperations<Handle>[], holdsSecret: (text: string) => boolean): Promise<boolean> {
  for (const document of documents) {
    if (decodeFieldValues(await document.callForString(fieldValues, [])).some(holdsSecret)) {
      return true;
    }
  }
  return false;
}

// The text a fill of literal text or of lines types; a secret reference is revealed elsewhere.
const textToFill = (value: Extract<ResolvedActionStep, { type: 'fill' }>['value']): string =>
  (typeof value === 'string' ? value : 'lines' in value ? value.lines.join('\n') : '');

// What a click does with the element it found and where it will press, just before the press.
type BeforePress<Handle> = (element: Handle, at: Point) => Promise<void>;
const NOTHING_BEFORE_PRESS = (): Promise<void> => Promise.resolve();

// The ports of one document. `masked` lists the documents a screenshot masks: this one and every
// document it is framed in, so a capture from inside a frame hides what the top page hides. The
// first of them is the top document.
function documentPorts<Handle>(
  operations: PageOperations<Handle>, masked: readonly PageOperations<Handle>[], environment: SessionEnvironment, details: SessionDetails,
): DocumentSession {
  const isTopDocument = masked.length === 1;
  const events = details.events;
  const crashed = (): boolean => events.crashed();
  const timeout = environment.timeoutMilliseconds;

  const probeNow = async (planLocator: Locator, read?: DomRead): Promise<ElementProbe> => {
    // A value reference, or a locator this session cannot resolve, says nothing about the page.
    const locator = performableLocator(planLocator, SESSION_FEATURES);
    if (locator === undefined || crashed()) return READ_FAILED;
    try {
      if (await rejectsSelector(operations, locator)) return { ...NOTHING_READ, count: 0, selectorInvalid: true };
      const found = await findElements(operations, locator);
      // Looked at after the search, so a navigation that fails during it cannot read as a page
      // with nothing on it.
      if ((await operations.callForString(documentUrl, [])).startsWith(BROWSER_ERROR_PAGE)) {
        return ON_BROWSER_ERROR_PAGE;
      }
      const element = found[0];
      if (found.length !== 1 || element === undefined) return { ...NOTHING_READ, count: found.length };
      const shown = JSON.parse(await operations.callForString(probeElement, [{ element }, environment.sensitiveSelectors])) as Extract<ElementProbe, { readonly count: number }>;
      // The link target and aria-current come from the document, the other states from the
      // browser's accessibility engine, as assistive technology reads them.
      const { href, current } = decodeLinkAndCurrent(await operations.callForString(linkAndCurrent, [{ element }]));
      const exposed = await operations.exposedStates(element);
      // A DOM check's read: a class list, a computed style or an attribute, read from the document.
      const dom = read === undefined ? undefined : decodeDomValue(await operations.callForString(readDomValue, [{ element }, read.kind, domReadName(read)]), read);
      return { ...shown, states: { ...exposed, current }, href, ...(dom === undefined ? {} : { dom }) };
    } catch (error) {
      return error instanceof PageHeldByDialog ? DIALOG_HOLDS_PAGE : READ_FAILED;
    }
  };

  // A read the page does not answer in time is one that says nothing about what is on it.
  const probe = async (planLocator: Locator, read?: DomRead): Promise<ElementProbe> => {
    const probed = await forAtMost(timeout, probeNow(planLocator, read));
    return probed === TIMED_OUT ? READ_FAILED : probed;
  };

  // A step has one timeout, whatever it spent the time on, so input gets what the wait for the element
  // left of it.
  const inputWithinTimeout = async <Value>(input: Promise<Value>, stepDeadline: number): Promise<Result<Value, DriverError>> => {
    const left = Math.max(stepDeadline - Date.now(), Math.min(SHORTEST_INPUT_MILLISECONDS, timeout));
    const ended = await forAtMost(left, input);
    return ended === TIMED_OUT ? failure({ code: 'timeout', detail: `the input was still being handled after ${timeout} ms` }) : success(ended);
  };

  // What a press left in the hit check. A dialog the press opened stops the page until it is answered,
  // which holds up the read: the press landed. With no check left to read, as after a navigation, or
  // no answer, the press landed only if the element it was sent to has gone. Otherwise nothing says
  // where it went, so the step fails.
  const readHitAfterClick = async (element: Handle): Promise<string> => {
    let hit: string;
    try {
      hit = await operations.callForString(readHitCheck, []);
    } catch (readFailure) {
      if (readFailure instanceof PageHeldByDialog || await operations.isElementGone(element)) {
        return 'hit';
      }
      throw readFailure;
    }
    return hit === 'none' && await operations.isElementGone(element) ? 'hit' : hit;
  };

  // A click is sent once. The wait may find a new element, and the guard is asked about the one it
  // finds, just before the send. A press that lands on another element is swallowed in the page and
  // fails the step at once: sending it again could press whatever the page has put there since. A
  // press the check never saw was stopped before it reached the page, by a listener of the page's
  // that came first, so the click did nothing.
  const click = async (locator: ResolvedLocator, guard: ActionGuard, beforePress: BeforePress<Handle>, stepDeadline: number): Promise<Result<void, DriverError>> => {
    const waited = await waitUntilActionable(operations, locator, timeout, timeout, crashed);
    if (!waited.ok) return waited;
    const { element, at } = waited.value;
    const denied = await clickDenial(operations, element, at, guard);
    if (denied !== null) {
      return failure(denied);
    }
    await beforePress(element, at);
    await operations.callForString(armHitCheck, [{ element }]);
    const clickAndReadHit = async (): Promise<string> => {
      await operations.click(element, at);
      return readHitAfterClick(element);
    };
    const hit = await inputWithinTimeout(clickAndReadHit(), stepDeadline);
    if (!hit.ok) {
      return hit;
    }
    if (hit.value === 'miss') {
      return failure({ code: 'not-actionable', detail: 'the click landed on another element' });
    }
    if (hit.value === 'none') {
      return failure({ code: 'not-actionable', detail: 'the press never reached the page' });
    }
    return success(undefined);
  };

  // The action itself, once the step is known to be performable.
  const perform = async (action: ResolvedActionStep, guard: ActionGuard, typedSecret: Secret | null, beforePress: BeforePress<Handle>, stepDeadline: number): Promise<Result<void, DriverError>> => {
    if (action.type === 'click') return click(action.locator, guard, beforePress, stepDeadline);
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
    const waited = await waitUntilActionable(operations, action.locator, timeout, timeout, crashed);
    if (!waited.ok) return waited;
    const { element, at } = waited.value;
    const denied = await denial(operations, element, guard);
    if (denied !== null) return failure(denied);
    switch (action.type) {
      case 'hover': await operations.hover(at); break;
      // The secret is revealed here, as it is typed, and nowhere else in this driver. Lines are
      // joined by line feeds and inserted as text, so no Enter key press can send a form early.
      // Noted before typing: a fill that fails part way may still have typed some of it.
      case 'fill':
        if (typedSecret !== null) {
          details.secretTypedFields.push({ locator: action.locator, isGone: () => operations.isElementGone(element) });
        }
        await operations.fill(element, typedSecret === null ? textToFill(action.value) : reveal(typedSecret));
        break;
      case 'press': {
        // Enter on a form or a link starts a navigation as a click does.
        const pressed = await inputWithinTimeout(operations.press(element, action.key, heldModifierKeys(action.modifiers ?? [], process.platform)), stepDeadline);
        if (!pressed.ok) {
          return pressed;
        }
        break;
      }
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
  const answerDialog = async (step: DialogStep, guard: ActionGuard): Promise<Result<void, DriverError>> => {
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
    const denied = denialOf(guard(NO_RESOLVED_ELEMENT, text));
    if (denied !== null) {
      return failure(denied);
    }
    await events.answerDialog(step.action === 'accept');
    return success(undefined);
  };

  // Waits for what an input started to show. A navigation it started has its effect only once it
  // arrives, however long the old page goes on answering, and one that turns out to be a download
  // ends a moment before the browser says so.
  const inputSettled = async (): Promise<void> => {
    await operations.twoFramesLater();
    await events.navigationEnded();
    await operations.twoFramesLater();
  };

  const failureOfThrow = (error: unknown): DriverError => {
    if (error instanceof PageHeldByDialog) {
      return DIALOG_OPEN;
    }
    return crashed() ? CRASHED : { code: 'not-actionable', detail: errorText(error) };
  };

  const actBeforePress = async (step: ActionStep, guard: ActionGuard, secret: Secret | undefined, beforePress: BeforePress<Handle>): Promise<Result<void, DriverError>> => {
    // The type requires a guard, but what calls this may not be checked against the type.
    if (typeof guard !== 'function') {
      return failure(NO_GUARD);
    }
    if (crashed()) return failure(CRASHED);
    if (step.type === 'dialog') {
      try { return await answerDialog(step, guard); } catch (error) { return failure(crashed() ? CRASHED : { code: 'not-actionable', detail: errorText(error) }); }
    }
    // Anything this driver cannot perform in full is refused before it touches the page.
    const action = literalActionStep(step, SESSION_FEATURES);
    if (action === undefined) return failure({ code: 'unsupported-step', detail: `this driver does not perform this ${step.type} step yet` });
    // A secret reference arrives with the secret the engine resolved for it. Without that secret
    // there is nothing to type, and typing nothing could pass a step that should fail.
    const typed = action.type === 'fill' ? action.value : '';
    const typedSecret = typeof typed === 'string' || 'lines' in typed ? null : secret?.name === typed.secretName ? secret : undefined;
    if (typedSecret === undefined) return failure({ code: 'not-actionable', detail: 'a secret reference reached the driver without its secret' });
    const openingsBefore = events.unsupportedOpenings();
    const stepDeadline = Date.now() + timeout;
    let acted: Result<void, DriverError>;
    try {
      const rejected = await forAtMost(timeout, rejectsSelector(operations, action.locator));
      if (rejected === TIMED_OUT) {
        return failure(notAnswering(timeout));
      }
      if (rejected) {
        return failure(SELECTOR_INVALID);
      }
      acted = await perform(action, guard, typedSecret, beforePress, stepDeadline);
      if (acted.ok) {
        const settled = await inputWithinTimeout(inputSettled(), stepDeadline);
        if (!settled.ok) {
          acted = settled;
        }
      }
    } catch (error) {
      acted = failure(failureOfThrow(error));
    }
    // The audit log holds this denial, so nothing noticed in the same moment may take its place.
    if (!acted.ok && acted.error.code === 'policy-denied') {
      return acted;
    }
    if (crashed()) return failure(CRASHED);
    if (events.unsupportedOpenings() > openingsBefore) {
      return failure({ code: 'unsupported-step', detail: 'the step opened a popup or a second page, or started a download' });
    }
    return acted;
  };

  const act = (step: ActionStep, guard: ActionGuard, secret?: Secret): Promise<Result<void, DriverError>> => actBeforePress(step, guard, secret, NOTHING_BEFORE_PRESS);

  // A download step: the click, guarded as any click, with the browser armed, just before the press,
  // to save the one download it starts. A popup the click opens, or a download that is not its own,
  // fails the step with unsupported-step and nothing of it is kept.
  const download = async (step: DownloadStep, maximumBytes: number, guard: ActionGuard): Promise<Result<DownloadedFile, DriverError>> => {
    if (typeof guard !== 'function') {
      return failure(NO_GUARD);
    }
    if (crashed()) return failure(CRASHED);
    const capture = details.downloads;
    const locator = performableLocator(step.locator, SESSION_FEATURES);
    if (capture === undefined || locator === undefined) return failure({ code: 'unsupported-step', detail: 'this driver does not perform this download step' });
    try {
      if (await rejectsSelector(operations, locator)) return failure(SELECTOR_INVALID);
    } catch (error) {
      return failure(failureOfThrow(error));
    }
    const openingsBefore = events.unsupportedOpenings();
    const hasOpenedAnother = (): boolean => events.unsupportedOpenings() > openingsBefore;
    const armed = capture.arm();
    let kept = false;
    try {
      const clicked = await actBeforePress({ type: 'click', locator }, guard, undefined, async (element, at) => {
        await armed.expectFromPress({ frameId: await operations.frameId(), canStartFile: await operations.canPressStartAnything(element, at) });
      });
      if (!clicked.ok) return clicked;
      const saved = await armed.finish(maximumBytes, timeout, () => crashed() || hasOpenedAnother());
      if (crashed()) return failure(CRASHED);
      if (hasOpenedAnother()) {
        return failure({ code: 'unsupported-step', detail: 'something other than the click started a file, or the click opened a popup, a second page or a second download' });
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
    const openingsBefore = events.unsupportedOpenings();
    let ended: ScriptCallOutcome | typeof TIMED_OUT;
    try {
      ended = await forAtMost(call.timeoutMilliseconds, operations.callScript(call.source, call.arguments, call.maximumResultBytes));
    } catch (error) {
      if (error instanceof PageHeldByDialog) {
        return failure(DIALOG_OPEN);
      }
      return failure(crashed() ? CRASHED : { code: 'script-failed', detail: errorText(error) });
    }
    if (crashed()) return failure(CRASHED);
    if (ended === TIMED_OUT) return failure({ code: 'script-timeout', detail: `the script did not settle within ${call.timeoutMilliseconds} ms` });
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

  // What masks paint before the viewport is captured, then take away.
  const maskedScreenshot = async (mask: readonly string[], paintBesides: () => Promise<void>): Promise<Uint8Array> => {
    await operations.callForString(fontsReady, []);
    for (const framed of masked) {
      await framed.callForString(maskElements, [mask]);
    }
    try {
      await paintBesides();
      return await operations.screenshotPng();
    } finally {
      for (const framed of masked) {
        await framed.callForString(unmaskElements, []);
      }
    }
  };

  const screenshotWithFieldsHidden = async (
    mask: readonly string[], fields: readonly ResolvedLocator[], holdsSecret: (text: string) => boolean,
  ): Promise<Result<Uint8Array, DriverError>> => {
    // True when a field no locator finds has gone, and what was typed into it with it.
    const canBeLeftUnmasked = async (field: ResolvedLocator): Promise<boolean> =>
      await hasTypedFieldGone(details.secretTypedFields, field) && !await hasFieldHoldingASecret(masked, holdsSecret);
    const toPaint: { readonly framed: PageOperations<Handle>; readonly elements: readonly Handle[] }[] = [];
    for (const field of fields) {
      let isFound = false;
      let isEveryDocumentRead = true;
      for (const framed of masked) {
        const elements = await findElements(framed, field).catch(() => null);
        isEveryDocumentRead &&= elements !== null;
        isFound ||= elements !== null && elements.length > 0;
        toPaint.push({ framed, elements: elements ?? [] });
      }
      if (!isFound && !(isEveryDocumentRead && await canBeLeftUnmasked(field))) {
        return failure({ code: 'not-found', detail: 'a field a secret was typed into cannot be found to hide it' });
      }
    }
    return success(await maskedScreenshot(mask, async () => {
      for (const { framed, elements } of toPaint) {
        await framed.callForString(maskGivenElements, elements.map((element) => ({ element })));
      }
    }));
  };

  const ports: DocumentSession = {
    async navigate(url, options) {
      if (crashed()) return failure(CRASHED);
      const scripts = options?.scripts ?? 'enabled';
      // Scripts are a setting of the whole page, so only the top document's navigate turns them off.
      if (scripts === 'disabled' && !isTopDocument) return failure({ code: 'unsupported-step', detail: 'scripts can be turned off only for the top document' });
      try {
        await operations.navigate(url, Math.max(timeout, 10_000), scripts);
        // What the page started as it loaded is the navigate's, once it has reached the browser.
        await forAtMost(timeout, operations.twoFramesLater());
        return success(undefined);
      } catch (error) {
        return failure(crashed() ? CRASHED : { code: 'navigation-failed', detail: errorText(error) });
      }
    },
    async page(): Promise<PageProbe> {
      const shown = decodePageInfo(await answeredWithin(timeout, operations.callForString(pageInfo, [])));
      // In place of a page it could not show, the browser shows its own error page at an internal
      // URL. The address bar still shows the URL it wanted, which is not a page that loaded.
      if (!shown.url.startsWith(BROWSER_ERROR_PAGE)) return shown;
      return { ...shown, url: await operations.unreachableUrl() ?? shown.url, browserErrorPage: true };
    },
    act,
    probe,
    download,
    runScript,
    screenshot: (mask) => answeredWithin(timeout, maskedScreenshot(mask, () => Promise.resolve())),
    // Each field is found before anything is painted, so no image exists for a field that cannot be.
    // A field its locator no longer finds holds nothing on screen only if the element typed into has
    // gone and no other field holds what was typed: one still on the page may still show it, and a
    // page may have rendered it afresh under another label. A read that throws shows neither.
    async screenshotHidingFields(mask, fields, holdsSecret) {
      const taken = await forAtMost(timeout, screenshotWithFieldsHidden(mask, fields, holdsSecret));
      return taken === TIMED_OUT ? failure(notAnswering(timeout)) : taken;
    },
    async audit() {
      return toFindings(parseAudit(await answeredWithin(timeout, operations.callForString(pageAudit, []))));
    },
    accessibilitySnapshot: () => operations.accessibilityTree(),
    async linkTargets() {
      return decodeLinkTargets(await operations.callForString(linkTargetList, []));
    },
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
    isDialogOpen: () => events.openDialog() !== null,
    unsupportedOpenings: () => events.unsupportedOpenings(),
  };
  return ports;
}

// Opens a second tab and loads the URL in it. A tab whose page does not load is closed at once.
async function newTabAt(openTab: () => Promise<Result<DriverSession, DriverError>>, url: string, crashed: () => boolean): Promise<Result<DriverSession, DriverError>> {
  const opened = await openTab();
  if (!opened.ok) return crashed() ? failure(CRASHED) : opened;
  const tab = opened.value;
  const navigated = await tab.navigate(url);
  if (navigated.ok) return success(tab);
  // Why the tab could not load is the step's failure; a tab that also fails to close must not replace it.
  await tab.close().catch(() => undefined);
  return navigated;
}

export function buildSession<Handle>(operations: PageOperations<Handle>, environment: SessionEnvironment, details: SessionDetails): DriverSession {
  const openTab = details.openTab;
  return {
    ...documentPorts(operations, [operations], environment, details),
    ...(openTab === undefined ? {} : { newTab: (url: string) => newTabAt(openTab, url, () => details.events.crashed()) }),
    ...(details.network === undefined ? {} : { network: details.network }),
    ...(details.storage === undefined ? {} : { storage: details.storage }),
    ...(details.clock === undefined ? {} : { clock: details.clock }),
    ...(details.clipboard === undefined ? {} : { clipboard: details.clipboard }),
    browser: details.browser,
    processId: details.processId,
    blockedOrigins: details.blockedOrigins,
    connectionFailures: details.connectionFailures,
    egressRecords: details.egressRecords,
    evaluate: (pageFunction: PageFunction, inputs = []) => operations.callForString(pageFunction, inputs),
    close: details.close,
  };
}
