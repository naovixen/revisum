// The own CDP driver: launches Chromium itself and speaks the Chrome DevTools Protocol over a
// WebSocket, with no third-party automation library.
import {
  determinismScript, deviceProfile, failure, mergeRefusedOrigins, success,
  type A11yNode, type DriverError, type Key, type Result, type SessionEnvironment, type SessionTab, type Target,
} from '@revisum/contracts';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { chromiumBuild } from './browser-build.ts';
import { buildSession, buildTab, errorText, type SessionDetails } from './browser-session.ts';
import { ADD_BINDING, ADD_SCRIPT_ON_NEW_DOCUMENT, ATTACH_TO_TARGET, CAPTURE_SCREENSHOT, CLOSE_TARGET, CREATE_BROWSER_CONTEXT, CREATE_ISOLATED_WORLD, CREATE_TARGET, ENABLE_PAGE, ENABLE_RUNTIME, GET_FRAME_TREE, GET_VERSION, NAVIGATE, SET_DEVICE_METRICS, SET_EMULATED_MEDIA, SET_FOCUS_EMULATION, SET_LOCALE, SET_SCRIPT_EXECUTION_DISABLED, SET_TIME_ZONE, SET_TOUCH_EMULATION, SET_USER_AGENT, type BrowserCommand, type CallArgument, type CallResult, type FrameTree, type RemoteObject } from './BrowserCommand.ts';
import { BINDING_CALLED, FRAME_STOPPED_LOADING, LOAD_EVENT_FIRED, type RequestAtResponseStage } from './BrowserEvent.ts';
import { CALL_FUNCTION_ON, DESCRIBE_NODE, EVALUATE, GET_EVENT_LISTENERS, GET_FULL_ACCESSIBILITY_TREE, GET_PARTIAL_ACCESSIBILITY_TREE, GET_PROPERTIES, QUERY_ACCESSIBILITY_TREE, RELEASE_OBJECT, RELEASE_OBJECT_GROUP, RESOLVE_NODE, RUN_IF_WAITING_FOR_DEBUGGER, SET_FILE_INPUT_FILES } from './CallFunctionOn.ts';
import { CONTINUE_REQUEST, DISPATCH_KEY_EVENT, DISPATCH_MOUSE_EVENT, ENABLE_REQUEST_HOLDING, FAIL_REQUEST, FULFIL_REQUEST, GET_RESPONSE_BODY, INSERT_TEXT } from './DispatchMouseEvent.ts';
import type { CdpConnection, CdpSessionClient } from './cdp-connection.ts';
import { DownloadFolder } from './downloads.ts';
import { EgressRecorder } from './egress-records.ts';
import { DocumentGone } from './DocumentGone.ts';
import { CLICK_WATCH_SCRIPT, PressSent, type CheckRead, type PressCheck } from './HitChecks.ts';
import { BrowserNetwork } from './network-stubs.ts';
import { afterTwoFrames, focusAndSelect, focusElement, frameContentOffset, isConnectedToItsDocument, isNotDisabledByItsProperty, scriptResultText, selectOption } from './in-page.ts';
import { MalformedBrowserReply } from './MalformedBrowserReply.ts';
import type { HeldModifierKey } from './modifier-keys.ts';
import {
  SelectOutcome,
  type DriverSession, type ExposedStates, type OwnBrowserDriver, type PageArgument, type PageFunction, type PageWithInput, type Point, type RoleAndName, type ScriptCallOutcome,
} from './page-operations.ts';
import { nodesAPressPasses, pressActsByItself } from './NodesAPressPasses.ts';
import { PageHeldByDialog } from './PageHeldByDialog.ts';
import { PageWatch, holdUnreadableEvent, type AttachedPage, type SessionFailures } from './page-watch.ts';
import { RunClipboard, SHARED_BROWSER_CLIPBOARD, allowRunClipboard } from './run-clipboard.ts';
import { openSessionEgress, type EgressSource, type OpenedSessionEgress } from './SessionEgress.ts';
import { attachToSharedBrowser, launchOwnBrowser, type AttachedBrowser, type BrowserSource } from './SharedBrowser.ts';
import { BrowserClock } from './virtual-clock.ts';
import { PageStorage } from './web-storage.ts';

const CDP_ADAPTER_VERSION = '0.1.0';
const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
// Schemes the page may load without an allow-list check: they never reach the network.
const LOCAL_SCHEMES = ['data:', 'about:', 'blob:', 'chrome-error:'];
const isAllowedUrl = (url: URL, allowedOrigins: readonly string[]): boolean =>
  allowedOrigins.includes(url.origin) || LOCAL_SCHEMES.includes(url.protocol);

type KeyDefinition = { readonly key: string; readonly code: string; readonly keyCode: number; readonly text?: string };
// Letters, digits and function keys follow the US keyboard layout's key codes, as Chromium expects.
const letterKey = (letter: string): KeyDefinition =>
  ({ key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0), text: letter });
const digitKey = (digit: string): KeyDefinition => ({ key: digit, code: `Digit${digit}`, keyCode: digit.charCodeAt(0), text: digit });
const FIRST_FUNCTION_KEY_CODE = 112;
const functionKey = (number: number): KeyDefinition =>
  ({ key: `F${number}`, code: `F${number}`, keyCode: FIRST_FUNCTION_KEY_CODE + number - 1 });
const KEY_DEFINITIONS: { readonly [Name in Key]: KeyDefinition } = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  'a': letterKey('a'), 'b': letterKey('b'), 'c': letterKey('c'), 'd': letterKey('d'), 'e': letterKey('e'), 'f': letterKey('f'), 'g': letterKey('g'),
  'h': letterKey('h'), 'i': letterKey('i'), 'j': letterKey('j'), 'k': letterKey('k'), 'l': letterKey('l'), 'm': letterKey('m'), 'n': letterKey('n'),
  'o': letterKey('o'), 'p': letterKey('p'), 'q': letterKey('q'), 'r': letterKey('r'), 's': letterKey('s'), 't': letterKey('t'), 'u': letterKey('u'),
  'v': letterKey('v'), 'w': letterKey('w'), 'x': letterKey('x'), 'y': letterKey('y'), 'z': letterKey('z'),
  '0': digitKey('0'), '1': digitKey('1'), '2': digitKey('2'), '3': digitKey('3'), '4': digitKey('4'),
  '5': digitKey('5'), '6': digitKey('6'), '7': digitKey('7'), '8': digitKey('8'), '9': digitKey('9'),
  Backquote: { key: '`', code: 'Backquote', keyCode: 192, text: '`' },
  Minus: { key: '-', code: 'Minus', keyCode: 189, text: '-' },
  Equal: { key: '=', code: 'Equal', keyCode: 187, text: '=' },
  BracketLeft: { key: '[', code: 'BracketLeft', keyCode: 219, text: '[' },
  BracketRight: { key: ']', code: 'BracketRight', keyCode: 221, text: ']' },
  Backslash: { key: '\\', code: 'Backslash', keyCode: 220, text: '\\' },
  Semicolon: { key: ';', code: 'Semicolon', keyCode: 186, text: ';' },
  Quote: { key: '\'', code: 'Quote', keyCode: 222, text: '\'' },
  Comma: { key: ',', code: 'Comma', keyCode: 188, text: ',' },
  Period: { key: '.', code: 'Period', keyCode: 190, text: '.' },
  Slash: { key: '/', code: 'Slash', keyCode: 191, text: '/' },
  'F1': functionKey(1), 'F2': functionKey(2), 'F3': functionKey(3), 'F4': functionKey(4), 'F5': functionKey(5), 'F6': functionKey(6),
  'F7': functionKey(7), 'F8': functionKey(8), 'F9': functionKey(9), 'F10': functionKey(10), 'F11': functionKey(11), 'F12': functionKey(12),
};
// The modifier keys, as the left-hand key of each pair, and the bit each sets in the protocol's
// modifiers mask, which tells the page which keys are held.
const MODIFIER_KEY_DEFINITIONS: { readonly [Name in HeldModifierKey]: KeyDefinition & { readonly bit: number } } = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, bit: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, bit: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, bit: 4 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, bit: 8 },
};
// The protocol's location for the left-hand key of a pair.
const LEFT_KEY = 1;
const modifierMask = (held: readonly HeldModifierKey[]): number => held.reduce((mask, modifier) => mask | MODIFIER_KEY_DEFINITIONS[modifier].bit, 0);

// What the US keyboard layout types for a key pressed with Shift, where it differs from the key.
const SHIFTED_TEXT: Readonly<Record<string, string>> = {
  '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', '\'': '"', ',': '<', '.': '>', '/': '?',
};

// The key as pressed with the held modifiers. With Alt, Control or Meta held it types nothing, as a
// keyboard shortcut does not; with Shift alone it types its shifted character.
function heldKeyDefinition(definition: KeyDefinition, held: readonly HeldModifierKey[]): KeyDefinition {
  if (held.some((modifier) => modifier !== 'Shift')) return { key: definition.key, code: definition.code, keyCode: definition.keyCode };
  if (!held.includes('Shift') || definition.text === undefined) return definition;
  const shifted = SHIFTED_TEXT[definition.text] ?? (/^[a-z]$/.test(definition.text) ? definition.text.toUpperCase() : definition.text);
  return { ...definition, key: definition.text === definition.key ? shifted : definition.key, text: shifted };
}

// Chromium-internal roles mapped to ARIA roles, and structural roles left out of snapshots.
const ROLE_NAMES: Readonly<Record<string, string>> = { RootWebArea: 'document', image: 'img', LabelText: 'label' };
const TRANSPARENT_ROLES = new Set(['none', 'generic', 'StaticText', 'InlineTextBox', 'LineBreak', 'ignored', 'presentation']);

// The remote objects a page script's call makes, released together once its result is written.
const SCRIPT_OBJECT_GROUP = 'driver-page-script';

// A remote value passed back to the page as a call argument: by reference, as a value JSON cannot
// carry (NaN, a bigint), or as undefined, which an empty argument stands for.
function callArgumentOf(remote: RemoteObject): CallArgument {
  if (remote.objectId !== undefined) return { objectId: remote.objectId };
  if (remote.unserializableValue !== undefined) return { unserializableValue: remote.unserializableValue };
  return remote.type === 'undefined' ? {} : { value: remote.value };
}

// Decodes what scriptResultText (in-page.ts) gives. Anything of another shape, such as from a page
// that replaced JSON.stringify, is a result JSON cannot write.
function decodeScriptResult(value: unknown): ScriptCallOutcome {
  if (Array.isArray(value) && value.length === 2 && value[0] === 'text' && typeof value[1] === 'string') return { kind: 'result', text: value[1] };
  return { kind: 'not-json' };
}

export type CdpDriverOptions = {
  readonly executablePath: string;
  readonly launchTimeoutMilliseconds?: number;
  // The project's fixtures folder. An upload step sends a declared fixture from here, and a stub
  // serves one from here, never a file outside it. Without it, the driver refuses every upload and
  // every stub with a fixture body.
  readonly fixturesFolder?: string;
  // Gives each session an egress proxy of its own, on its browser context. The browser-wide proxy is a
  // dead one, for Chrome's own traffic.
  readonly egress: EgressSource;
  // Where sessions get a browser someone else launched. Without it, as in production, every session
  // launches a browser of its own and ends it on close.
  readonly browserSource?: BrowserSource;
};

// The bytes of a declared fixture inside the fixtures folder, for a stub's body.
function readFixture(fixturesFolder: string | undefined, fixture: string): Result<Uint8Array, DriverError> {
  const path = fixtureFilePath(fixturesFolder, fixture);
  if (!path.ok) return path;
  try {
    return success(readFileSync(path.value));
  } catch (error) {
    return failure({ code: 'not-found', detail: `the fixture could not be read: ${errorText(error)}` });
  }
}

// The absolute path of a declared fixture inside the fixtures folder. A name that leads out of the
// folder, by "..", an absolute path or a link, is refused, as is a file that is not there.
function fixtureFilePath(fixturesFolder: string | undefined, fixture: string): Result<string, DriverError> {
  if (fixturesFolder === undefined) return failure({ code: 'unsupported-step', detail: 'this driver was given no fixtures folder to upload from' });
  let folder: string;
  let file: string;
  try {
    folder = realpathSync(fixturesFolder);
    file = realpathSync(resolve(folder, fixture));
  } catch {
    return failure({ code: 'not-found', detail: 'the fixture file is not in the fixtures folder' });
  }
  const inside = relative(folder, file);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return failure({ code: 'not-actionable', detail: 'the fixture leads outside the fixtures folder' });
  }
  return success(file);
}

export function cdpDriver(options: CdpDriverOptions): OwnBrowserDriver {
  return {
    info: { id: 'cdp', version: CDP_ADAPTER_VERSION, protocol: 'Chrome DevTools Protocol (raw WebSocket)' },
    supports(target) {
      if (target.engine !== 'chromium') return failure({ reason: 'engine-not-supported', detail: 'CDP drives Chromium only' });
      return success(true);
    },
    async build(target) {
      if (target.engine !== 'chromium') return failure({ code: 'engine-not-supported', detail: 'CDP drives Chromium only' });
      return chromiumBuild(options.executablePath);
    },
    async open(target, environment) {
      if (target.engine !== 'chromium') return failure({ reason: 'engine-not-supported', detail: 'CDP drives Chromium only' });
      const opened = await openSessionEgress(options.egress, environment.allowedOrigins);
      if (!opened.ok) {
        return failure({ reason: 'launch-failed', detail: opened.error });
      }
      const sessionEgress = opened.value;
      const closeEgress = (): Promise<void> => sessionEgress.egress.close();
      let attached: AttachedBrowser;
      try {
        attached = await attachBrowser(options, target.locale);
      } catch (error) {
        return failure({ reason: 'launch-failed', detail: await detailAfterClosing(error, [closeEgress]) });
      }
      try {
        return success(await createSession(attached, sessionEgress, target, environment, options.fixturesFolder));
      } catch (error) {
        // A shared browser that keeps this context stays refused to later sessions, so what to
        // report first here is what stopped this one opening.
        return failure({ reason: 'launch-failed', detail: await detailAfterClosing(error, [() => attached.close(), closeEgress]) });
      }
    },
  };
}

function attachBrowser(options: CdpDriverOptions, locale: string): Promise<AttachedBrowser> {
  const { executablePath, browserSource, launchTimeoutMilliseconds } = options;
  const settings = { executablePath, locale };
  if (browserSource !== undefined) {
    return browserSource(locale).then((shared) => attachToSharedBrowser(shared, settings));
  }
  return launchOwnBrowser(settings, launchTimeoutMilliseconds);
}

// Why a session did not open, then anything that also went wrong clearing up after it.
async function detailAfterClosing(error: unknown, closers: readonly (() => Promise<void>)[]): Promise<string> {
  const details = [errorText(error)];
  for (const close of closers) {
    try {
      await close();
    } catch (closeError) {
      details.push(`closing what it had opened failed too: ${errorText(closeError)}`);
    }
  }
  return details.join('; ');
}

// What every page of one session shares: the browser's own context, the target and environment it
// emulates, the egress allow-list's record of blocked origins, the egress recorder, the download
// folder, the stubs and request checks, which reach every tab, the run's virtual clock, and what has
// gone wrong outside any one command.
type SessionBrowser = {
  readonly connection: CdpConnection;
  readonly browserContextId: string;
  readonly userAgent: string;
  readonly target: Target;
  readonly environment: SessionEnvironment;
  readonly blocked: string[];
  readonly recorder: EgressRecorder;
  readonly downloads: DownloadFolder;
  readonly network: BrowserNetwork;
  readonly clock: BrowserClock;
  readonly failures: SessionFailures;
};

// A held-back popup never loads, so it is always recorded as a request that went nowhere. Only an
// undeclared address is a refusal of the origin: a run may well reach a declared one in its own tab.
function recordPopupRequest(browser: SessionBrowser, requestedUrl: string): void {
  const url = URL.parse(requestedUrl);
  if (url !== null && !isAllowedUrl(url, browser.environment.allowedOrigins)) {
    browser.recorder.recordUndeclaredPopup(requestedUrl);
    browser.blocked.push(url.origin);
    return;
  }
  browser.recorder.record(requestedUrl, 'popup');
}

// How long a new tab is given to attach after the browser creates it.
const TAB_ATTACH_TIMEOUT_MILLISECONDS = 10_000;

async function createSession(
  attached: AttachedBrowser, sessionEgress: OpenedSessionEgress, target: Target, environment: SessionEnvironment, fixturesFolder: string | undefined,
): Promise<DriverSession> {
  const connection = attached.connection;
  const version = await connection.ask(undefined, GET_VERSION, {});
  const { browserContextId } = await connection.ask(undefined, CREATE_BROWSER_CONTEXT, { disposeOnDetach: true, ...sessionEgress.contextProxy });
  const { targetId } = await connection.ask(undefined, CREATE_TARGET, { url: 'about:blank', browserContextId });
  const { sessionId } = await connection.ask(undefined, ATTACH_TO_TARGET, { targetId, flatten: true });
  const failures: SessionFailures = { refusedDecisions: [], cleanUp: [] };
  // Every request's origin and channel, for the run's egress events.
  const recorder = new EgressRecorder(connection, failures);
  const browser: SessionBrowser = {
    connection, browserContextId, userAgent: version.userAgent, target, environment, blocked: [], recorder,
    downloads: new DownloadFolder(connection, browserContextId),
    network: new BrowserNetwork(connection, {
      readFixture: (fixture) => readFixture(fixturesFolder, fixture),
      onAnsweredInBrowser: (requestId) => { recorder.answeredInBrowser(requestId); },
      onMalformedEvent: holdUnreadableEvent(failures),
    }),
    clock: new BrowserClock(environment.virtualTimers === true),
    failures,
  };
  await allowRunClipboard(connection, browserContextId);

  await connection.ask(sessionId, ENABLE_PAGE, {});
  const watch = new PageWatch(connection, { browserContextId, targetId, sessionId }, {
    failures: browser.failures, onPopupRequest: (url) => { recordPopupRequest(browser, url); }, ownsBrowserContext: true, claimsDownload: (event) => browser.downloads.claims(event), isDownloadStepUnderWay: () => browser.downloads.isArmed(),
  });
  await watch.start();
  await browser.recorder.start(sessionId);
  await browser.network.watchPage(sessionId);
  browser.downloads.watchResponses(sessionId);
  await preparePage(browser, sessionId, watch);
  await browser.clock.watchPage((command, parameters) => watch.ask(command, parameters), () => watch.crashed());

  const operations = new CdpPage(connection, sessionId, watch, null);
  const details: SessionDetails = {
    browser: { name: 'chromium', version: /\/(\S+)$/.exec(version.product)?.[1] ?? version.product },
    processId: attached.processId,
    blockedOrigins: () => mergeRefusedOrigins(browser.blocked, sessionEgress.egress.refusedOrigins()),
    connectionFailures: () => sessionEgress.egress.connectionFailures(),
    egressRecords: () => browser.recorder.records(),
    // Popups settle first, so the blocked origins are complete once this ends. This page's watch sees
    // every popup of the browser context, whichever tab opened it. The download folder goes once the
    // browser can no longer write into it. A shared browser that keeps the session's context rejects
    // here, and the folder stays for the same reason. The egress goes last, whatever happened, since
    // nothing else ends it. Clean-up failures are read while the session still runs: closing fails
    // whatever was still waiting for an answer, which says nothing about it.
    close: () => closeInTurn([
      () => watch.settleHeldPopupsAndReportCleanUp(),
      async () => {
        await attached.close();
        browser.downloads.remove();
      },
      () => sessionEgress.egress.close(),
    ]),
    events: watch,
    fixturePath: (fixture) => fixtureFilePath(fixturesFolder, fixture),
    downloads: browser.downloads,
    secretTypedFields: [],
    openTab: () => openTab(browser, watch, details),
    network: browser.network,
    storage: pageStorage(watch),
    clock: browser.clock,
    clipboard: attached.isShared
      ? SHARED_BROWSER_CLIPBOARD
      : new RunClipboard(connection, browserContextId, (command, parameters) => watch.askRunningPage(command, parameters), () => watch.crashed()),
  };
  return buildSession(operations, environment, details);
}

// Runs every closer, whatever the others did, and then rejects with all that went wrong.
async function closeInTurn(closers: readonly (() => Promise<void>)[]): Promise<void> {
  const failed: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      failed.push(error);
    }
  }
  if (failed.length === 1) {
    throw failed[0];
  }
  if (failed.length > 1) {
    throw new Error(failed.map(errorText).join('; '));
  }
}

// Makes a page of the session hermetic and repeatable before it loads anything: the target's
// device, locale, time zone, colour scheme and motion, the determinism script, emulated focus (a
// headless page has none, and the clipboard needs it), the click checks' world, and the egress
// allow-list, whose refusals join the session's blocked origins.
async function preparePage(browser: SessionBrowser, sessionId: string, watch: PageWatch): Promise<void> {
  const { connection, target, environment } = browser;
  const page = connection.session(sessionId);
  const profile = deviceProfile(target);
  await page.ask(SET_DEVICE_METRICS, { width: profile.width, height: profile.height, deviceScaleFactor: profile.scale, mobile: profile.mobile });
  // The quoted key is the protocol's own parameter name.
  if (profile.touch) await page.ask(SET_TOUCH_EMULATION, { enabled: true, 'maxTouchPoints': 5 });
  await page.ask(SET_LOCALE, { locale: target.locale });
  await page.ask(SET_TIME_ZONE, { timezoneId: target.timezone });
  // navigator.language follows Accept-Language, so the locale needs both overrides.
  await page.ask(SET_USER_AGENT, { userAgent: browser.userAgent, acceptLanguage: target.locale });
  await page.ask(SET_EMULATED_MEDIA, { features: [
    { name: 'prefers-reduced-motion', value: target.reducedMotion },
    { name: 'prefers-color-scheme', value: target.colorScheme },
  ] });
  await page.ask(SET_FOCUS_EMULATION, { enabled: true });
  await page.ask(ADD_SCRIPT_ON_NEW_DOCUMENT, { source: determinismScript(environment.seed, environment.fixedTimeMilliseconds) });
  // The browser tells the driver of a binding's calls only with this domain on. Only the click checks'
  // world has the binding, so the page's scripts cannot call it.
  await page.ask(ENABLE_RUNTIME, {});
  await page.ask(ADD_BINDING, { name: PRESS_REPORT_BINDING, executionContextName: CLICK_CHECK_WORLD_NAME });
  await page.ask(ADD_SCRIPT_ON_NEW_DOCUMENT, { source: CLICK_WATCH_SCRIPT, worldName: CLICK_CHECK_WORLD_NAME });

  // Every request is paused and either let through (allowed origin) or failed and recorded. An
  // allowed fetch or XHR request an active stub matches is answered by the stub instead. A request
  // whose response fields a plan may read is held again once its response is in, for its body.
  watch.onRequestPaused(sessionId, (paused) => {
    if (paused.stage === 'response') { void takeResponseBody(page, browser.network, paused, watch); return; }
    const url = URL.parse(paused.request.url);
    // A URL that cannot be parsed is blocked, with no origin to show.
    const allowed = url !== null && isAllowedUrl(url, environment.allowedOrigins);
    if (url !== null && !allowed) {
      browser.blocked.push(url.origin);
    }
    const stubbed = allowed ? browser.network.answer(paused) : null;
    const sendDecision = async (): Promise<void> => {
      if (stubbed !== null) {
        await page.ask(FULFIL_REQUEST, { requestId: paused.requestId, ...stubbed.response });
        stubbed.onAccepted();
        return;
      }
      if (!allowed) {
        await page.ask(FAIL_REQUEST, { requestId: paused.requestId, errorReason: 'BlockedByClient' });
        return;
      }
      await page.ask(CONTINUE_REQUEST, { requestId: paused.requestId, ...(browser.network.wantsResponseBody(paused) ? { interceptResponse: true as const } : {}) });
    };
    sendDecision().catch((error: unknown) => { watch.noteDecisionFailure(error); });
  });
  await page.ask(ENABLE_REQUEST_HOLDING, { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}

// How the browser says a held response has no body to take: it is a redirect or has none, or nothing
// is held any more. Any other failure is reported at the session's close.
const NO_BODY_TO_TAKE = /Can only get response body|No data found|No resource with given|Request content was evicted|Invalid InterceptionId|Session with given id not found|connection closed/;

// Takes the body of a response held at the response stage, for the request check that reads its
// fields, then lets the page have it unchanged. A body that cannot be taken is left out: the
// exchange still counts, with no body to read.
async function takeResponseBody(page: CdpSessionClient, network: BrowserNetwork, held: RequestAtResponseStage, watch: PageWatch): Promise<void> {
  if (!held.hasFailed && held.networkId !== undefined) {
    try {
      const fetched = await page.ask(GET_RESPONSE_BODY, { requestId: held.requestId });
      network.keepResponseBody(held.networkId, Buffer.from(fetched.body, fetched.base64Encoded ? 'base64' : 'utf8'));
    } catch (error) {
      if (!NO_BODY_TO_TAKE.test(errorText(error))) {
        watch.noteCleanUpFailure(`a response's body could not be taken: ${errorText(error)}`);
      }
    }
  }
  await page.ask(CONTINUE_REQUEST, { requestId: held.requestId }).catch((error: unknown) => { watch.noteDecisionFailure(error); });
}

// Opens a second tab in the session's own browser context, so it shares cookies and storage. The
// first page's watch hands the tab over still paused; it is prepared exactly as the first page
// was, then let run on about:blank. Closing it closes only the tab.
async function openTab(browser: SessionBrowser, firstWatch: PageWatch, firstDetails: SessionDetails): Promise<Result<SessionTab, DriverError>> {
  const { connection, browserContextId } = browser;
  const attaching = firstWatch.nextTab(TAB_ATTACH_TIMEOUT_MILLISECONDS);
  let attached: AttachedPage;
  try {
    await connection.ask(undefined, CREATE_TARGET, { url: 'about:blank', browserContextId });
    attached = await attaching.promise;
  } catch (error) {
    attaching.cancel();
    return failure({ code: 'navigation-failed', detail: `the new tab did not open: ${errorText(error)}` });
  }
  const watch = new PageWatch(connection, { browserContextId, targetId: attached.targetId, sessionId: attached.sessionId }, {
    failures: browser.failures, onPopupRequest: (url) => { recordPopupRequest(browser, url); }, ownsBrowserContext: false, claimsDownload: (event) => browser.downloads.claims(event), isDownloadStepUnderWay: () => browser.downloads.isArmed(),
  });
  let stopResponses = (): void => undefined;
  let stopNetwork = (): void => undefined;
  let stopClock = (): void => undefined;
  // Never rejects: what stops a tab closing is for the session's close to report, and must not take the
  // place of what a step found.
  const close = async (): Promise<void> => {
    watch.stop();
    stopResponses();
    stopNetwork();
    stopClock();
    await connection.ask(undefined, CLOSE_TARGET, { targetId: attached.targetId }).catch((error: unknown) => { watch.noteTargetFailure('a tab could not be closed', error); });
  };
  try {
    await connection.ask(attached.sessionId, ENABLE_PAGE, {});
    await watch.start();
    await browser.recorder.start(attached.sessionId);
    stopNetwork = await browser.network.watchPage(attached.sessionId);
    stopResponses = browser.downloads.watchResponses(attached.sessionId);
    await preparePage(browser, attached.sessionId, watch);
    stopClock = await browser.clock.watchPage((command, parameters) => watch.ask(command, parameters), () => watch.crashed());
    await connection.ask(attached.sessionId, RUN_IF_WAITING_FOR_DEBUGGER, {});
  } catch (error) {
    await close();
    return failure({ code: 'navigation-failed', detail: `the new tab could not be prepared: ${errorText(error)}` });
  }
  const operations = new CdpPage(connection, attached.sessionId, watch, null);
  return success(buildTab(operations, browser.environment, {
    fixturePath: firstDetails.fixturePath, downloads: browser.downloads, events: watch, close, secretTypedFields: firstDetails.secretTypedFields,
  }));
}

// The storage port of one page, whose commands fail at once once its renderer has died.
const pageStorage = (watch: PageWatch): PageStorage =>
  new PageStorage((command, parameters) => watch.askRunningPage(command, parameters), () => watch.crashed());

// Where a CdpPage's document is when it is an iframe's: its element in the parent document, and its frame.
type FrameScope = {
  readonly parent: CdpPage;
  readonly frameElement: string;
  readonly frameId: string;
};

// The accessibility properties that hold an element's selected, expanded and pressed states.
const EXPOSED_STATE_PROPERTIES = ['selected', 'expanded', 'pressed'] as const;

// A state property's value: a boolean, or a tristate text. "mixed" (partly pressed) counts as on.
function stateValue(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === 'mixed') return true;
  if (value === false || value === 'false') return false;
  return null;
}

// The name of the isolated script world the driver reads every document through. The page's own scripts
// cannot reach it, so what they replace is not what a read calls, and what a read says is not theirs to
// write. It runs too where the page's own world does not: with the page's scripts turned off, in a
// document whose own security policy forbids them, and while its timers run on virtual time.
const READING_WORLD_NAME = 'driver-frame';
// The name of the isolated script world click checks live in. The browser gives a frame's document one
// world for each name, so this makes no more of them however many clicks there are.
const CLICK_CHECK_WORLD_NAME = 'driver-click-check';
// What the click checks' world calls to report a press as it goes, while nothing else can be read.
const PRESS_REPORT_BINDING = 'driverPressReport';
// How long what a check reported before a dialog opened, or its document went, is given to arrive. It
// was on its way before either, by another route to the driver.
const REPORTS_ARRIVE_MILLISECONDS = 100;
// A kept check's objects are grouped by frame, so that one nobody holds any more can still be let go,
// and letting go of one document's cannot touch a check that is live in another.
const outOfReachObjectGroup = (frameId: string): string => `driver-kept-out-of-reach-${frameId}`;
// What Page.navigate reports for a response whose HTTP status is an error and whose body is empty.
const HTTP_ERROR_STATUS = 'net::ERR_HTTP_RESPONSE_CODE_FAILURE';
// Messages of a command about an object whose document was replaced, or whose tab has closed.
const LOST_OBJECT = /Cannot find context|Could not find object|Execution context was destroyed|Inspected target navigated or closed|Session with given id not found/i;
// How making a script world fails for a frame the page has removed.
const FRAME_REMOVED = /No frame for given id found/;
// The events a pointer's press sends on its way, or sets off when it moves the focus.
const PRESS_EVENT = /^(?:pointer|mouse|click|auxclick|dblclick|touch|focus|blur|contextmenu)/;

// How Runtime.callFunctionOn hands back what a page function returns.
type CallDelivery = { readonly awaitPromise: true; readonly returnByValue: boolean };
const AWAITED_VALUE: CallDelivery = { awaitPromise: true, returnByValue: true };
const AWAITED_OBJECT: CallDelivery = { awaitPromise: true, returnByValue: false };

function throwIfThePageThrew(called: CallResult): void {
  if (called.exceptionDetails !== undefined) throw new Error(`page exception: ${called.exceptionDetails.exception?.value ?? called.exceptionDetails.text}`);
}

function textOfCall(called: CallResult): string {
  const text = called.result.value;
  if (typeof text !== 'string') {
    throw new MalformedBrowserReply(CALL_FUNCTION_ON.method, 'result.result.value');
  }
  return text;
}

const callArgumentsOf = (inputs: readonly PageArgument<string>[]): CallArgument[] =>
  inputs.map((input) => (typeof input === 'object' && 'element' in input ? { objectId: input.element } : { value: input }));

// The ids of the frame and of every frame inside it, or none when it is no longer in the tree.
function frameIdsInside(tree: FrameTree, frameId: string): readonly string[] {
  if (tree.frame.id === frameId) {
    const everyFrame = (inside: FrameTree): readonly string[] => [inside.frame.id, ...(inside.childFrames ?? []).flatMap(everyFrame)];
    return everyFrame(tree);
  }
  return (tree.childFrames ?? []).flatMap((child) => frameIdsInside(child, frameId));
}

// PageOperations over one flat CDP session, for its top document or one of its iframes' documents.
// Element handles are remote object ids.
class CdpPage implements PageWithInput<string> {
  readonly protocol = 'cdp' as const;
  readonly accessibilityTreeSource = 'browser' as const;
  readonly #connection: CdpConnection;
  readonly #sessionId: string;
  readonly #watch: PageWatch;
  readonly #frame: FrameScope | null;
  // For the top document: whether the page's scripts are off, and its frame's id once known. A page's
  // top frame keeps its id for as long as the tab lives.
  #scriptsDisabled = false;
  #topFrameId: string | null = null;

  constructor(connection: CdpConnection, sessionId: string, watch: PageWatch, frame: FrameScope | null) {
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.#watch = watch;
    this.#frame = frame;
  }

  // Every command goes through the watch, so a crashed page or one a dialog holds fails it at once.
  async #ask<CommandParameters, Reply>(command: BrowserCommand<CommandParameters, Reply>, parameters: NoInfer<CommandParameters>): Promise<Reply> {
    try {
      return await this.#watch.askRunningPage(command, parameters);
    } catch (error) {
      if (error instanceof Error && (LOST_OBJECT.test(error.message) || FRAME_REMOVED.test(error.message))) {
        throw new DocumentGone(error.message);
      }
      throw error;
    }
  }

  // Sends input to a page no dialog holds. A dialog that opens while it waits is the input landing,
  // such as the mouse release whose click opens one: this ends then, since the browser answers the
  // command itself only once the dialog is answered.
  async #sendInput<CommandParameters>(command: BrowserCommand<CommandParameters, void>, parameters: NoInfer<CommandParameters>): Promise<void> {
    if (this.#watch.openDialog() !== null) {
      throw new PageHeldByDialog(command.method);
    }
    const opened = this.#watch.dialogOpened();
    try {
      await Promise.race([this.#watch.ask(command, parameters), opened.promise]);
    } finally {
      opened.cancel();
    }
  }

  async navigate(url: string, timeoutMilliseconds: number, scripts: 'enabled' | 'disabled'): Promise<void> {
    const frameId = this.#frame?.frameId;
    // Script execution is a setting of the whole page, so only the top document's navigate changes
    // it; it stays as set until the next one.
    if (frameId === undefined) {
      const disable = scripts === 'disabled';
      if (disable !== this.#scriptsDisabled) {
        await this.#ask(SET_SCRIPT_EXECUTION_DISABLED, { value: disable });
        this.#scriptsDisabled = disable;
      }
    }
    const loaded = this.#whenLoaded(frameId, timeoutMilliseconds);
    try {
      // Sent whatever holds the page: a navigation away ends a dialog, and the browser answers it.
      // The browser answers once the document's own request has gone on, which a refused decision stops.
      const navigated = await this.#watch.failingOnRefusedDecision(
        this.#watch.ask(NAVIGATE, { url, ...(frameId === undefined ? {} : { frameId }) }),
      );
      // An HTTP error status with an empty body is a page the server did send: the browser shows
      // its own error page for it, and the plan's checks decide what that means.
      const navigationError = navigated.errorText ?? '';
      if (navigationError !== '' && navigationError !== HTTP_ERROR_STATUS) throw new Error(navigationError);
      const notLoaded = await this.#watch.failingOnRefusedDecision(this.#watch.failingOnCrash(NAVIGATE.method, loaded.promise));
      if (notLoaded !== null) {
        throw new Error(notLoaded);
      }
    } finally {
      loaded.cancel();
    }
  }

  // Resolves as the document has loaded, with null, or with what to say when it has not in time. The
  // top document has loaded at its load event; a frame once it stops loading.
  #whenLoaded(frameId: string | undefined, timeoutMilliseconds: number): { readonly promise: Promise<string | null>; cancel(): void } {
    const onMalformed = (detail: string): void => { this.#watch.noteUnreadableEvent(detail); };
    let stopListening = (): void => undefined;
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<string | null>((resolveLoaded) => {
      const loaded = (): void => {
        clearTimeout(timer);
        stopListening();
        resolveLoaded(null);
      };
      stopListening = frameId === undefined
        ? this.#connection.listen(this.#sessionId, LOAD_EVENT_FIRED, loaded, onMalformed)
        : this.#connection.listen(this.#sessionId, FRAME_STOPPED_LOADING, (stopped) => { if (stopped.frameId === frameId) loaded(); }, onMalformed);
      const notInTime = frameId === undefined ? `${LOAD_EVENT_FIRED.name}: timeout after ${timeoutMilliseconds} ms` : `the frame did not load within ${timeoutMilliseconds} ms`;
      timer = setTimeout(() => { stopListening(); resolveLoaded(notInTime); }, timeoutMilliseconds);
    });
    return { promise, cancel: () => { clearTimeout(timer); stopListening(); } };
  }

  async #isolatedWorld(frameId: string, worldName = READING_WORLD_NAME): Promise<number> {
    const created = await this.#ask(CREATE_ISOLATED_WORLD, { frameId, worldName });
    return created.executionContextId;
  }

  // The world this document is read through. Asked for at each read, since the browser gives a document
  // one for each name, and a document that has changed since has a new one.
  async #readingWorld(): Promise<number> {
    return this.#isolatedWorld(await this.frameId());
  }

  // The document object, in the world given.
  async #documentObject(world: number): Promise<string> {
    const evaluated = await this.#ask(EVALUATE, { expression: 'document', contextId: world });
    if (evaluated.result.objectId === undefined) throw new Error('no document');
    return evaluated.result.objectId;
  }

  async #call(pageFunction: PageFunction, inputs: readonly PageArgument<string>[], delivery: CallDelivery): Promise<CallResult> {
    const objectId = await this.#documentObject(await this.#readingWorld());
    const called = await this.#ask(CALL_FUNCTION_ON, {
      functionDeclaration: pageFunction.toString(), objectId, arguments: callArgumentsOf(inputs), ...delivery,
    });
    throwIfThePageThrew(called);
    return called;
  }

  async callForString(pageFunction: PageFunction, inputs: readonly PageArgument<string>[]): Promise<string> {
    return textOfCall(await this.#call(pageFunction, inputs, AWAITED_VALUE));
  }

  async callForStringInMainWorld(pageFunction: PageFunction, inputs: readonly PageArgument<string>[]): Promise<string> {
    const called = await this.#ask(CALL_FUNCTION_ON, {
      functionDeclaration: pageFunction.toString(), objectId: await this.#mainWorldDocument(), arguments: callArgumentsOf(inputs), ...AWAITED_VALUE,
    });
    throwIfThePageThrew(called);
    return textOfCall(called);
  }

  async twoFramesLater(): Promise<void> {
    try {
      await this.callForString(afterTwoFrames, []);
    } catch (error) {
      const isDocumentGone = LOST_OBJECT.test(errorText(error)) || FRAME_REMOVED.test(errorText(error));
      if (!(error instanceof PageHeldByDialog) && !this.#watch.crashed() && !isDocumentGone) {
        throw error;
      }
    }
  }

  async callForElements(pageFunction: PageFunction, inputs: readonly PageArgument<string>[]): Promise<string[]> {
    const list = (await this.#call(pageFunction, inputs, AWAITED_OBJECT)).result.objectId;
    // Every function called here returns an array, so no object means the page got in the way.
    if (list === undefined) throw new Error('the page gave no list of elements');
    const properties = await this.#ask(GET_PROPERTIES, { objectId: list, ownProperties: true });
    return properties.result
      .filter((property) => /^\d+$/.test(property.name))
      .map((property) => {
        const handle = property.value?.objectId;
        if (handle === undefined) {
          throw new MalformedBrowserReply(GET_PROPERTIES.method, `result.${property.name}.value.objectId`);
        }
        return handle;
      });
  }

  async withPressCheck<Value>(arm: PageFunction, element: string, use: (check: PressCheck) => Promise<Value>): Promise<Value> {
    const frameId = await this.frameId();
    const executionContextId = await this.#isolatedWorld(frameId, CLICK_CHECK_WORLD_NAME);
    const pressId = this.#watch.nextPressId();
    const reported = new Set<string>();
    const stopListening = this.#connection.listen(this.#sessionId, BINDING_CALLED, ({ name, payload }) => {
      const [fromPress, what] = payload.split(' ');
      if (name === PRESS_REPORT_BINDING && fromPress === pressId && what !== undefined) {
        reported.add(what);
      }
    }, (detail) => { this.#watch.noteUnreadableEvent(detail); });
    try {
      const check = await this.#armOutOfReach(arm, element, executionContextId, frameId, pressId);
      try {
        return await use({
          read: (pageFunction) => this.#readCheck(check, pageFunction),
          reports: async () => {
            await pause(REPORTS_ARRIVE_MILLISECONDS);
            return reported;
          },
        });
      } finally {
        // Not waited for: what the step needs is in, and the browser answers nothing to a page that has
        // started to navigate, which a click often makes it do.
        void this.#releaseKept(RELEASE_OBJECT, { objectId: check });
      }
    } finally {
      stopListening();
    }
  }

  async #armOutOfReach(arm: PageFunction, element: string, executionContextId: number, frameId: string, pressId: string): Promise<string> {
    const described = await this.#ask(DESCRIBE_NODE, { objectId: element });
    const resolved = await this.#ask(RESOLVE_NODE, { backendNodeId: described.node.backendNodeId, executionContextId });
    const elementInWorld = resolved.object.objectId;
    try {
      const called = await this.#ask(CALL_FUNCTION_ON, {
        functionDeclaration: arm.toString(), executionContextId, arguments: [{ objectId: elementInWorld }, { value: PRESS_REPORT_BINDING }, { value: pressId }],
        returnByValue: false, objectGroup: outOfReachObjectGroup(frameId),
      });
      throwIfThePageThrew(called);
      const kept = called.result.objectId;
      if (kept === undefined) {
        throw new Error('the page function gave no object to keep');
      }
      return kept;
    } finally {
      await this.#releaseKept(RELEASE_OBJECT, { objectId: elementInWorld });
    }
  }

  // A read says what became of the check in every case, since each one means something to a press.
  async #readCheck(check: string, pageFunction: PageFunction): Promise<CheckRead> {
    try {
      const called = await this.#ask(CALL_FUNCTION_ON, { functionDeclaration: pageFunction.toString(), objectId: check, returnByValue: true });
      throwIfThePageThrew(called);
      return { kind: 'answered', value: called.result.value };
    } catch (error) {
      if (error instanceof PageHeldByDialog) {
        return { kind: 'held-by-dialog' };
      }
      return LOST_OBJECT.test(errorText(error)) ? { kind: 'document-gone' } : { kind: 'failed', detail: errorText(error) };
    }
  }

  async callInEveryFramedDocumentOutOfReach(pageFunction: PageFunction): Promise<void> {
    const { frameTree } = await this.#ask(GET_FRAME_TREE, {});
    for (const frameId of frameIdsInside(frameTree, await this.frameId())) {
      if (await this.#hasTakenSomethingOff(frameId, pageFunction)) {
        // Not waited for, as a page that has started to navigate answers nothing, and the browser has it
        // before anything sent after this. While a dialog held the page it could not be let go.
        void this.#releaseKept(RELEASE_OBJECT_GROUP, { objectGroup: outOfReachObjectGroup(frameId) });
      }
    }
  }

  // A document that has gone took its check with it, so there are no listeners left to take off.
  async #hasTakenSomethingOff(frameId: string, pageFunction: PageFunction): Promise<boolean> {
    try {
      const executionContextId = await this.#isolatedWorld(frameId, CLICK_CHECK_WORLD_NAME);
      const called = await this.#ask(CALL_FUNCTION_ON, { functionDeclaration: pageFunction.toString(), executionContextId, returnByValue: true });
      throwIfThePageThrew(called);
      return called.result.value === true;
    } catch (error) {
      if (LOST_OBJECT.test(errorText(error)) || FRAME_REMOVED.test(errorText(error))) {
        return false;
      }
      throw error;
    }
  }

  // Never rejects, since a caller is no better off for it: a failure other than the object having gone is
  // kept for the session's close to report. An object whose document or page has gone has gone too, and
  // one a dialog holds goes with its document, so none of these has anything to report.
  async #releaseKept<CommandParameters>(command: BrowserCommand<CommandParameters, void>, parameters: NoInfer<CommandParameters>): Promise<void> {
    try {
      await this.#ask(command, parameters);
    } catch (error) {
      const isOutOfReach = error instanceof PageHeldByDialog || this.#watch.crashed() || LOST_OBJECT.test(errorText(error));
      if (!isOutOfReach) {
        this.#watch.noteCleanUpFailure(`a kept object could not be released: ${errorText(error)}`);
      }
    }
  }

  async byRole(role: string, name: string): Promise<string[]> {
    const world = await this.#readingWorld();
    const root = (await this.#ask(DESCRIBE_NODE, { objectId: await this.#documentObject(world) })).node.backendNodeId;
    const queried = await this.#ask(QUERY_ACCESSIBILITY_TREE, {
      backendNodeId: root, role: role === 'img' ? 'image' : role, accessibleName: name,
    });
    const handles: string[] = [];
    for (const node of queried.nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue;
      const resolved = await this.#ask(RESOLVE_NODE, { backendNodeId: node.backendDOMNodeId, executionContextId: world });
      handles.push(resolved.object.objectId);
    }
    return handles;
  }

  async roleAndName(element: string): Promise<RoleAndName> {
    const { nodes } = await this.#ask(GET_PARTIAL_ACCESSIBILITY_TREE, { objectId: element, fetchRelatives: false });
    const node = nodes[0];
    if (node === undefined || node.ignored) return { role: null, name: null };
    const role = node.role === undefined || node.role === '' ? null : node.role;
    const name = node.name === undefined || node.name === '' ? null : node.name;
    return { role: role === null ? null : ROLE_NAMES[role] ?? role, name };
  }

  async exposedStates(element: string): Promise<ExposedStates> {
    const { nodes } = await this.#ask(GET_PARTIAL_ACCESSIBILITY_TREE, { objectId: element, fetchRelatives: false });
    const properties = nodes[0]?.properties ?? [];
    const read = (name: (typeof EXPOSED_STATE_PROPERTIES)[number]): boolean | null => {
      const property = properties.find((candidate) => candidate.name === name);
      return property === undefined ? null : stateValue(property.value);
    };
    return { selected: read('selected'), expanded: read('expanded'), pressed: read('pressed') };
  }

  async accessibilityTree(): Promise<A11yNode> {
    const frameId = this.#frame?.frameId;
    const { nodes } = await this.#ask(GET_FULL_ACCESSIBILITY_TREE, frameId === undefined ? {} : { frameId });
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const build = (node: (typeof nodes)[number]): A11yNode[] => {
      const children = (node.childIds ?? []).flatMap((id) => { const child = byId.get(id); return child === undefined ? [] : build(child); });
      const role = node.role ?? 'none';
      if (node.ignored || TRANSPARENT_ROLES.has(role)) return children;
      return [{ role: ROLE_NAMES[role] ?? role, name: node.name ?? '', children }];
    };
    const root = nodes.find((node) => node.parentId === undefined) ?? nodes[0];
    const tree = root === undefined ? [] : build(root);
    return tree.length === 1 && tree[0] !== undefined ? tree[0] : { role: 'document', name: '', children: tree };
  }

  // Where this document's viewport starts in the top document's viewport: the sum of the frame
  // offsets on the way down. Mouse events are dispatched to the top document.
  async #viewportOffset(): Promise<Point> {
    const frame = this.#frame;
    if (frame === null) return { x: 0, y: 0 };
    const above = await frame.parent.#viewportOffset();
    const offset = decodePoint(await frame.parent.callForString(frameContentOffset, [{ element: frame.frameElement }]));
    return { x: above.x + offset.x, y: above.y + offset.y };
  }

  // Called on the element itself, in whichever world found it, since this document's world may be
  // a later document's by now.
  async isElementGone(element: string): Promise<boolean> {
    if (this.#watch.crashed()) {
      return true;
    }
    try {
      const called = await this.#ask(CALL_FUNCTION_ON, {
        functionDeclaration: isConnectedToItsDocument.toString(), objectId: element, returnByValue: true,
      });
      throwIfThePageThrew(called);
      if (typeof called.result.value !== 'boolean') {
        throw new MalformedBrowserReply(CALL_FUNCTION_ON.method, 'result.result.value');
      }
      return !called.result.value;
    } catch (error) {
      if (this.#watch.crashed() || LOST_OBJECT.test(errorText(error))) {
        return true;
      }
      throw error;
    }
  }

  async frameId(): Promise<string> {
    const framed = this.#frame?.frameId;
    if (framed !== undefined) {
      return framed;
    }
    this.#topFrameId ??= (await this.#ask(GET_FRAME_TREE, {})).frameTree.frame.id;
    return this.#topFrameId;
  }

  async canPressStartAnything(element: string, at: Point): Promise<boolean> {
    const passed = await this.callForElements(nodesAPressPasses, [{ element }, at.x, at.y]);
    if (await this.callForString(pressActsByItself, passed.map((node) => ({ element: node }))) === 'yes') {
      return true;
    }
    try {
      for (const node of passed) {
        if (await this.#hasPressListener(await this.#inMainWorld(node))) {
          return true;
        }
      }
      return await this.#hasPressListener(await this.#mainWorldWindow());
    } finally {
      await this.#releaseKept(RELEASE_OBJECT_GROUP, { objectGroup: SCRIPT_OBJECT_GROUP });
    }
  }

  // The read is all the page's code gets to run in, and a boolean is all that can come out of it. The
  // release is not waited for, as for a check: a page that has started to navigate answers nothing.
  async isCustomElementEnabled(element: string): Promise<boolean> {
    const inMainWorld = await this.#inMainWorld(element);
    try {
      const called = await this.#ask(CALL_FUNCTION_ON, { functionDeclaration: isNotDisabledByItsProperty.toString(), objectId: inMainWorld, returnByValue: true });
      return called.exceptionDetails === undefined && called.result.value === true;
    } finally {
      void this.#releaseKept(RELEASE_OBJECT, { objectId: inMainWorld });
    }
  }

  // The browser reports only the listeners of the script world the object is read through, and a
  // page's own are in its main world.
  async #inMainWorld(node: string): Promise<string> {
    const described = await this.#ask(DESCRIBE_NODE, { objectId: node });
    const resolved = await this.#ask(RESOLVE_NODE, { backendNodeId: described.node.backendNodeId, objectGroup: SCRIPT_OBJECT_GROUP });
    return resolved.object.objectId;
  }

  async #mainWorldWindow(): Promise<string> {
    const found = await this.#ask(CALL_FUNCTION_ON, {
      functionDeclaration: 'function () { return this.defaultView; }', objectId: await this.#mainWorldDocument(), objectGroup: SCRIPT_OBJECT_GROUP,
    });
    if (found.result.objectId === undefined) {
      throw new Error('the document has no window');
    }
    return found.result.objectId;
  }

  async #hasPressListener(objectId: string): Promise<boolean> {
    const { listeners } = await this.#ask(GET_EVENT_LISTENERS, { objectId });
    return listeners.some((listener) => PRESS_EVENT.test(listener.type));
  }

  async click(_element: string, at: Point): Promise<PressSent> {
    const offset = await this.#viewportOffset();
    const point = { x: at.x + offset.x, y: at.y + offset.y };
    const pressed = { ...point, button: 'left' as const, clickCount: 1 };
    await this.#sendInput(DISPATCH_MOUSE_EVENT, { type: 'mouseMoved', ...point });
    await this.#sendInput(DISPATCH_MOUSE_EVENT, { type: 'mousePressed', ...pressed });
    if (this.#watch.openDialog() !== null) return PressSent.HeldAtThePress;
    await this.#sendInput(DISPATCH_MOUSE_EVENT, { type: 'mouseReleased', ...pressed });
    return PressSent.Released;
  }

  async hover(at: Point): Promise<void> {
    const offset = await this.#viewportOffset();
    await this.#sendInput(DISPATCH_MOUSE_EVENT, { type: 'mouseMoved', x: at.x + offset.x, y: at.y + offset.y });
  }

  async fill(element: string, value: string): Promise<void> {
    await this.callForString(focusAndSelect, [{ element }]);
    if (value === '') await this.#pressKey(KEY_DEFINITIONS.Backspace);
    else await this.#sendInput(INSERT_TEXT, { text: value });
  }

  async press(element: string, key: Key, modifiers: readonly HeldModifierKey[]): Promise<void> {
    await this.callForString(focusElement, [{ element }]);
    const held: HeldModifierKey[] = [];
    for (const modifier of modifiers) {
      held.push(modifier);
      const definition = MODIFIER_KEY_DEFINITIONS[modifier];
      await this.#sendInput(DISPATCH_KEY_EVENT, {
        type: 'rawKeyDown', key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, location: LEFT_KEY, modifiers: modifierMask(held),
      });
      if (this.#watch.openDialog() !== null) return;
    }
    await this.#pressKey(heldKeyDefinition(KEY_DEFINITIONS[key], held), modifierMask(held));
    for (const modifier of [...modifiers].reverse()) {
      if (this.#watch.openDialog() !== null) return;
      held.splice(held.indexOf(modifier), 1);
      const definition = MODIFIER_KEY_DEFINITIONS[modifier];
      await this.#sendInput(DISPATCH_KEY_EVENT, {
        type: 'keyUp', key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, location: LEFT_KEY, modifiers: modifierMask(held),
      });
    }
  }

  async #pressKey(definition: KeyDefinition, modifiers = 0): Promise<void> {
    const common = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, modifiers };
    if (definition.text === undefined) {
      await this.#sendInput(DISPATCH_KEY_EVENT, { type: 'rawKeyDown', ...common });
    } else {
      await this.#sendInput(DISPATCH_KEY_EVENT, { type: 'keyDown', ...common, text: definition.text });
    }
    if (this.#watch.openDialog() !== null) return;
    await this.#sendInput(DISPATCH_KEY_EVENT, { type: 'keyUp', ...common });
  }

  async setFiles(element: string, paths: readonly string[]): Promise<void> {
    await this.#ask(SET_FILE_INPUT_FILES, { files: [...paths], objectId: element });
  }

  async select(element: string, option: string): Promise<SelectOutcome> {
    const chosen = await this.callForString(selectOption, [{ element }, option]);
    const outcome = Object.values(SelectOutcome).find((known) => known === chosen);
    if (outcome === undefined) {
      throw new MalformedBrowserReply(CALL_FUNCTION_ON.method, 'result.result.value');
    }
    return outcome;
  }

  async frame(element: string): Promise<PageWithInput<string> | null> {
    const described = await this.#ask(DESCRIBE_NODE, { objectId: element });
    const frameId = described.node.frameId;
    if (frameId === undefined) return null;
    try {
      await this.#isolatedWorld(frameId);
    } catch (error) {
      // A frame whose document runs in another renderer process has no world in this session.
      if (this.#watch.crashed()) throw error;
      return null;
    }
    return new CdpPage(this.#connection, this.#sessionId, this.#watch, { parent: this, frameElement: element, frameId });
  }

  async unreachableUrl(): Promise<string | null> {
    const { frameTree } = await this.#ask(GET_FRAME_TREE, {});
    const frameId = this.#frame?.frameId;
    const find = (tree: FrameTree): FrameTree | undefined =>
      (frameId === undefined || tree.frame.id === frameId ? tree : (tree.childFrames ?? []).map(find).find((found) => found !== undefined));
    return find(frameTree)?.frame.unreachableUrl ?? null;
  }

  // This document's object in the page's own main world, where page scripts run: the top
  // document's default world, or the main world of the iframe's document, which the browser
  // resolves a node in when given no world.
  async #mainWorldDocument(): Promise<string> {
    const frame = this.#frame;
    if (frame === null) {
      const evaluated = await this.#ask(EVALUATE, { expression: 'document', objectGroup: SCRIPT_OBJECT_GROUP });
      if (evaluated.result.objectId === undefined) throw new Error('no document');
      return evaluated.result.objectId;
    }
    const described = await this.#ask(DESCRIBE_NODE, { objectId: frame.frameElement });
    const backendNodeId = described.node.contentDocument?.backendNodeId;
    if (backendNodeId === undefined) throw new Error('the frame has no document');
    const resolved = await this.#ask(RESOLVE_NODE, { backendNodeId, objectGroup: SCRIPT_OBJECT_GROUP });
    return resolved.object.objectId;
  }

  // The source is compiled by the browser as the function it declares and called once with the
  // arguments object, never spliced into other text; then its result is written as JSON in the page.
  async callScript(source: string, scriptArguments: Readonly<Record<string, string | number | boolean>>, maximumResultBytes: number): Promise<ScriptCallOutcome> {
    try {
      const objectId = await this.#mainWorldDocument();
      const called = await this.#ask(CALL_FUNCTION_ON, {
        functionDeclaration: source, objectId, arguments: [{ value: scriptArguments }], awaitPromise: true, returnByValue: false, objectGroup: SCRIPT_OBJECT_GROUP,
      });
      if (called.exceptionDetails !== undefined) return { kind: 'threw' };
      const written = await this.#ask(CALL_FUNCTION_ON, {
        functionDeclaration: scriptResultText.toString(), objectId, arguments: [callArgumentOf(called.result), { value: maximumResultBytes }],
        returnByValue: true, objectGroup: SCRIPT_OBJECT_GROUP,
      });
      return written.exceptionDetails === undefined ? decodeScriptResult(written.result.value) : { kind: 'not-json' };
    } finally {
      await this.#releaseKept(RELEASE_OBJECT_GROUP, { objectGroup: SCRIPT_OBJECT_GROUP });
    }
  }

  async screenshotPng(): Promise<Uint8Array> {
    const captured = await this.#ask(CAPTURE_SCREENSHOT, { format: 'png' });
    return new Uint8Array(Buffer.from(captured.data, 'base64'));
  }
}

// Decodes the {x, y} JSON frameContentOffset (in-page.ts) reports.
function decodePoint(text: string): Point {
  const parsed: unknown = JSON.parse(text);
  const fields = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  const [x, y] = [fields['x'], fields['y']];
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error('the frame offset is not a point');
  return { x, y };
}
