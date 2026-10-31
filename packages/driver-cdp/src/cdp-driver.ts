// The own CDP driver: launches Chromium itself and speaks the Chrome DevTools Protocol over a
// WebSocket, with no third-party automation library. See docs/specs/SPEC-06-cdp-driver.md.
import {
  determinismScript, deviceProfile, failure, success,
  type A11yNode, type DriverError, type Key, type Result, type SessionEnvironment, type Target,
} from '@revisum/contracts';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { chromiumBuild } from './browser-build.ts';
import { SESSION_FEATURES, buildSession, errorText, type SessionDetails } from './browser-session.ts';
import { CdpConnection, type CdpSessionClient } from './cdp-connection.ts';
import { QUIET_CHROME_FLAGS, proxyFlags } from './chrome-flags.ts';
import { DownloadFolder } from './downloads.ts';
import { EgressRecorder } from './egress-records.ts';
import { launchChromium, type LaunchedChromium } from './chromium-launcher.ts';
import { BrowserNetwork, atResponseStage, type HeldRequest } from './network-stubs.ts';
import { focusAndSelect, focusElement, frameContentOffset } from './in-page.ts';
import type { HeldModifierKey } from './modifier-keys.ts';
import type {
  DriverSession, ExposedStates, OwnBrowserDriver, PageArgument, PageFunction, PageOperations, Point, RoleAndName,
} from './page-operations.ts';
import { PageWatch, type AttachedPage } from './page-watch.ts';
import { RunClipboard, allowRunClipboard } from './run-clipboard.ts';
import { BrowserClock } from './virtual-clock.ts';
import { PageStorage } from './web-storage.ts';

export const CDP_ADAPTER_VERSION = '0.1.0';
const COMMAND_TIMEOUT_MILLISECONDS = 30_000;
// Schemes the page may load without an allow-list check: they never reach the network.
const LOCAL_SCHEMES = ['data:', 'about:', 'blob:', 'chrome-error:'];

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

// Chrome DevTools Protocol shapes this driver reads.
type RemoteObject = { readonly type: string; readonly subtype?: string; readonly value?: unknown; readonly objectId?: string };
type CallResult = { readonly result: RemoteObject; readonly exceptionDetails?: { readonly text: string; readonly exception?: RemoteObject } };
type CallArgument = { readonly value?: unknown; readonly objectId?: string };
type AccessibilityValue = { readonly type: string; readonly value?: unknown };
type AccessibilityProperty = { readonly name: string; readonly value: AccessibilityValue };
type AccessibilityNode = {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly role?: AccessibilityValue;
  readonly name?: AccessibilityValue;
  readonly properties?: readonly AccessibilityProperty[];
  readonly childIds?: readonly string[];
  readonly parentId?: string;
  readonly backendDOMNodeId?: number;
};
type RequestPaused = HeldRequest & { readonly requestId: string };
type FrameTree = { readonly frame: { readonly id: string; readonly unreachableUrl?: string }; readonly childFrames?: readonly FrameTree[] };
type DescribedNode = { readonly node: { readonly backendNodeId: number; readonly frameId?: string } };

export type CdpDriverOptions = {
  readonly executablePath: string;
  readonly launchTimeoutMilliseconds?: number;
  // The project's fixtures folder. An upload step sends a declared fixture from here, and a stub
  // serves one from here, never a file outside it. Without it, the driver refuses every upload and
  // every stub with a fixture body.
  readonly fixturesFolder?: string;
  // The egress proxy every request goes through, such as the isolated runner's. includeLoopback
  // sends requests to 127.0.0.1 and localhost through it too; without it they go direct.
  readonly proxy?: { readonly server: string; readonly includeLoopback: boolean };
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
export function fixtureFilePath(fixturesFolder: string | undefined, fixture: string): Result<string, DriverError> {
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
    info: { id: 'cdp', version: CDP_ADAPTER_VERSION, protocol: 'Chrome DevTools Protocol (raw WebSocket)', performs: SESSION_FEATURES },
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
      let launched: LaunchedChromium;
      try {
        launched = await launchChromium(options.executablePath, {
          arguments: [...QUIET_CHROME_FLAGS, `--lang=${target.locale}`, ...(options.proxy === undefined ? [] : proxyFlags(options.proxy))],
          launchTimeoutMilliseconds: options.launchTimeoutMilliseconds ?? 30_000,
          commandTimeoutMilliseconds: COMMAND_TIMEOUT_MILLISECONDS,
          profilePrefix: 'cdp-driver-',
        });
      } catch (error) {
        return failure({ reason: 'launch-failed', detail: errorText(error) });
      }
      try {
        return success(await createSession(launched, target, environment, options.fixturesFolder));
      } catch (error) {
        await launched.stop();
        return failure({ reason: 'launch-failed', detail: errorText(error) });
      }
    },
  };
}

// What every page of one session shares: the browser's own context, the target and environment it
// emulates, the egress allow-list's record of blocked origins, the egress recorder, the download
// folder, the stubs and request checks, which reach every tab, and the run's virtual clock.
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
};

// How long a new tab is given to attach after the browser creates it.
const TAB_ATTACH_TIMEOUT_MILLISECONDS = 10_000;

async function createSession(
  launched: LaunchedChromium, target: Target, environment: SessionEnvironment, fixturesFolder: string | undefined,
): Promise<DriverSession> {
  const connection = launched.connection;
  const version = await connection.send<{ product: string; userAgent: string }>(undefined, 'Browser.getVersion');
  const { browserContextId } = await connection.send<{ browserContextId: string }>(undefined, 'Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await connection.send<{ targetId: string }>(undefined, 'Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await connection.send<{ sessionId: string }>(undefined, 'Target.attachToTarget', { targetId, flatten: true });
  // Every request's origin and channel, for the run's egress events.
  const recorder = new EgressRecorder(connection);
  const browser: SessionBrowser = {
    connection, browserContextId, userAgent: version.userAgent, target, environment, blocked: [], recorder,
    downloads: new DownloadFolder(connection, browserContextId),
    network: new BrowserNetwork(connection, {
      readFixture: (fixture) => readFixture(fixturesFolder, fixture),
      onAnsweredInBrowser: (requestId) => recorder.answeredInBrowser(requestId),
    }),
    clock: new BrowserClock(environment.virtualTimers === true),
  };
  await allowRunClipboard(connection, browserContextId);

  await connection.send(sessionId, 'Page.enable');
  const watch = new PageWatch(connection, { browserContextId, targetId, sessionId }, {
    onPopupRequest: (url) => browser.recorder.record(url, 'popup'), ownsBrowserContext: true, claimsDownload: (event) => browser.downloads.claims(event),
  });
  await watch.start();
  await browser.recorder.start(sessionId);
  await browser.network.watchPage(sessionId);
  browser.downloads.watchResponses(sessionId);
  await preparePage(browser, sessionId);
  await browser.clock.watchPage((method, parameters) => watch.command(method, parameters), () => watch.crashed());

  const operations = new CdpPage(connection, sessionId, watch, null, environment.virtualTimers === true);
  const details: SessionDetails = {
    browser: { name: 'chromium', version: /\/(\S+)$/.exec(version.product)?.[1] ?? version.product },
    processId: launched.browserProcess.pid ?? -1,
    blockedOrigins: () => browser.blocked,
    egressRecords: () => browser.recorder.records(),
    // The download folder goes once the browser can no longer write into it.
    close: async () => {
      try { await launched.stop(); } finally { browser.downloads.remove(); }
    },
    events: watch,
    fixturePath: (fixture) => fixtureFilePath(fixturesFolder, fixture),
    downloads: browser.downloads,
    openTab: () => openTab(browser, watch, details),
    network: browser.network,
    storage: pageStorage(watch),
    clock: browser.clock,
    clipboard: new RunClipboard(connection, browserContextId, (method, parameters) => watch.command(method, parameters), () => watch.crashed()),
  };
  return buildSession(operations, environment, details);
}

// Makes a page of the session hermetic and repeatable before it loads anything: the target's
// device, locale, time zone, colour scheme and motion, the determinism script, emulated focus (a
// headless page has none, and the clipboard needs it), and the egress allow-list, whose refusals
// join the session's blocked origins.
async function preparePage(browser: SessionBrowser, sessionId: string): Promise<void> {
  const { connection, target, environment } = browser;
  const page = connection.session(sessionId);
  const profile = deviceProfile(target);
  await page.send('Emulation.setDeviceMetricsOverride', { width: profile.width, height: profile.height, deviceScaleFactor: profile.scale, mobile: profile.mobile });
  // The quoted key is the protocol's own parameter name.
  if (profile.touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, 'maxTouchPoints': 5 });
  await page.send('Emulation.setLocaleOverride', { locale: target.locale });
  await page.send('Emulation.setTimezoneOverride', { timezoneId: target.timezone });
  // navigator.language follows Accept-Language, so the locale needs both overrides.
  await page.send('Emulation.setUserAgentOverride', { userAgent: browser.userAgent, acceptLanguage: target.locale });
  await page.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-motion', value: target.reducedMotion },
    { name: 'prefers-color-scheme', value: target.colorScheme },
  ] });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: determinismScript(environment.seed, environment.fixedTimeMilliseconds) });

  // Every request is paused and either let through (allowed origin) or failed and recorded. An
  // allowed fetch or XHR request an active stub matches is answered by the stub instead. A request
  // whose response fields a plan may read is held again once its response is in, for its body.
  page.on('Fetch.requestPaused', (parameters) => {
    const paused = parameters as RequestPaused;
    if (atResponseStage(paused)) { void takeResponseBody(page, browser.network, paused); return; }
    let allowed = false;
    try {
      const url = new URL(paused.request.url);
      allowed = environment.allowedOrigins.includes(url.origin) || LOCAL_SCHEMES.includes(url.protocol);
      if (!allowed) browser.blocked.push(url.origin);
    } catch { /* a URL that cannot be parsed is blocked */ }
    const stubbed = allowed ? browser.network.answer(paused) : null;
    const decision = stubbed !== null
      ? page.send('Fetch.fulfillRequest', { requestId: paused.requestId, ...stubbed })
      : allowed
        ? page.send('Fetch.continueRequest', { requestId: paused.requestId, ...(browser.network.wantsResponseBody(paused) ? { interceptResponse: true } : {}) })
        : page.send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'BlockedByClient' });
    decision.catch(() => undefined);
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}

type FetchedBody = { readonly body: string; readonly base64Encoded: boolean };

// Takes the body of a response held at the response stage, for the request check that reads its
// fields, then lets the page have it unchanged. A body that cannot be taken is left out: the
// exchange still counts, with no body to read.
async function takeResponseBody(page: CdpSessionClient, network: BrowserNetwork, held: RequestPaused): Promise<void> {
  if (held.responseErrorReason === undefined && held.networkId !== undefined) {
    try {
      const fetched = await page.send<FetchedBody>('Fetch.getResponseBody', { requestId: held.requestId });
      network.keepResponseBody(held.networkId, Buffer.from(fetched.body, fetched.base64Encoded ? 'base64' : 'utf8'));
    } catch { /* the response had no body to take */ }
  }
  await page.send('Fetch.continueRequest', { requestId: held.requestId }).catch(() => undefined);
}

// Opens a second tab in the session's own browser context, so it shares cookies and storage. The
// first page's watch hands the tab over still paused; it is prepared exactly as the first page
// was, then let run on about:blank. Closing it closes only the tab.
async function openTab(browser: SessionBrowser, firstWatch: PageWatch, firstDetails: SessionDetails): Promise<Result<DriverSession, DriverError>> {
  const { connection, browserContextId } = browser;
  const attaching = firstWatch.nextTab(TAB_ATTACH_TIMEOUT_MILLISECONDS);
  let attached: AttachedPage;
  try {
    await connection.send(undefined, 'Target.createTarget', { url: 'about:blank', browserContextId });
    attached = await attaching.promise;
  } catch (error) {
    attaching.cancel();
    return failure({ code: 'navigation-failed', detail: `the new tab did not open: ${errorText(error)}` });
  }
  const watch = new PageWatch(connection, { browserContextId, targetId: attached.targetId, sessionId: attached.sessionId }, {
    onPopupRequest: (url) => browser.recorder.record(url, 'popup'), ownsBrowserContext: false, claimsDownload: (event) => browser.downloads.claims(event),
  });
  let stopResponses = (): void => undefined;
  let stopNetwork = (): void => undefined;
  let stopClock = (): void => undefined;
  const close = async (): Promise<void> => {
    watch.stop();
    stopResponses();
    stopNetwork();
    stopClock();
    await connection.send(undefined, 'Target.closeTarget', { targetId: attached.targetId }).catch(() => undefined);
  };
  try {
    await connection.send(attached.sessionId, 'Page.enable');
    await watch.start();
    await browser.recorder.start(attached.sessionId);
    stopNetwork = await browser.network.watchPage(attached.sessionId);
    stopResponses = browser.downloads.watchResponses(attached.sessionId);
    await preparePage(browser, attached.sessionId);
    stopClock = await browser.clock.watchPage((method, parameters) => watch.command(method, parameters), () => watch.crashed());
    await connection.send(attached.sessionId, 'Runtime.runIfWaitingForDebugger');
  } catch (error) {
    await close();
    return failure({ code: 'navigation-failed', detail: `the new tab could not be prepared: ${errorText(error)}` });
  }
  const operations = new CdpPage(connection, attached.sessionId, watch, null, browser.environment.virtualTimers === true);
  // A tab opens no tab of its own: newTab is allowed only at the top level of a plan.
  return success(buildSession(operations, browser.environment, {
    browser: firstDetails.browser, processId: firstDetails.processId, blockedOrigins: firstDetails.blockedOrigins,
    egressRecords: firstDetails.egressRecords, fixturePath: firstDetails.fixturePath, downloads: browser.downloads, events: watch, close,
    network: browser.network, storage: pageStorage(watch), clock: browser.clock,
    ...(firstDetails.clipboard === undefined ? {} : { clipboard: firstDetails.clipboard }),
  }));
}

// The storage port of one page, whose commands fail at once once its renderer has died.
const pageStorage = (watch: PageWatch): PageStorage =>
  new PageStorage((method, parameters) => watch.command(method, parameters), () => watch.crashed());

// An isolated script world of one frame: the page's own scripts cannot see or change it; it shares
// only the document. The driver reads an iframe's document through one, and the top document
// through one while the page's scripts are off, since timers do not run in the page's own world
// then, and while the page's timers run on virtual time, since they wait for clock advances then.
type IsolatedWorld = { readonly frameId: string; executionContextId: number };

// Where a CdpPage's document is when it is an iframe's: its element in the parent document, and
// the isolated world it is read through.
type FrameScope = {
  readonly parent: CdpPage;
  readonly frameElement: string;
  readonly world: IsolatedWorld;
};

// The accessibility properties that hold an element's selected, expanded and pressed states.
const EXPOSED_STATE_PROPERTIES = ['selected', 'expanded', 'pressed'] as const;

// A state property's value: a boolean, or a tristate text. "mixed" (partly pressed) counts as on.
function stateValue(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === 'mixed') return true;
  if (value === false || value === 'false') return false;
  return null;
}

// The name of the isolated script world the driver reads a frame's document through.
const FRAME_WORLD_NAME = 'driver-frame';
// What Page.navigate reports for a response whose HTTP status is an error and whose body is empty.
const HTTP_ERROR_STATUS = 'net::ERR_HTTP_RESPONSE_CODE_FAILURE';
// Messages of a command that named an execution context the page has since destroyed.
const LOST_CONTEXT = /context|Cannot find/i;

// PageOperations over one flat CDP session, for its top document or one of its iframes' documents.
// Element handles are remote object ids.
class CdpPage implements PageOperations<string> {
  readonly protocol = 'cdp' as const;
  readonly accessibilityTreeSource = 'browser' as const;
  readonly #connection: CdpConnection;
  readonly #sessionId: string;
  readonly #watch: PageWatch;
  readonly #frame: FrameScope | null;
  // For the top document: whether the page's scripts are off, and the world it is read through then.
  #scriptsDisabled = false;
  #scriptsOffWorld: IsolatedWorld | null = null;
  // For the top document: whether the page's timers run on virtual time, and the world it is read
  // through then, made when first needed.
  readonly #virtualTimers: boolean;
  #virtualTimersWorld: IsolatedWorld | null = null;

  constructor(connection: CdpConnection, sessionId: string, watch: PageWatch, frame: FrameScope | null, virtualTimers = false) {
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.#watch = watch;
    this.#frame = frame;
    this.#virtualTimers = virtualTimers && frame === null;
  }

  // Every command goes through the watch, so a crashed page fails it at once.
  #send<Value = Record<string, unknown>>(method: string, parameters: Record<string, unknown> = {}): Promise<Value> {
    return this.#watch.command<Value>(method, parameters);
  }

  // Waits for a command that a dialog may hold up, such as the mouse release whose click opens a
  // dialog: it ends when the command does or when a dialog opens. The browser answers the command
  // itself only once the dialog is answered.
  async #untilDialog(command: Promise<unknown>): Promise<void> {
    command.catch(() => undefined);
    const opened = this.#watch.dialogOpened();
    try {
      await Promise.race([command, opened.promise]);
    } finally {
      opened.cancel();
    }
  }

  // The isolated world this document is read through, or null for the page's own world.
  #world(): IsolatedWorld | null {
    return this.#frame?.world ?? this.#scriptsOffWorld ?? this.#virtualTimersWorld;
  }

  // The world this document is read through, made first for a top document whose page's timers
  // run on virtual time.
  async #readingWorld(): Promise<IsolatedWorld | null> {
    const world = this.#world();
    if (world !== null || !this.#virtualTimers) return world;
    const { frameTree } = await this.#send<{ frameTree: FrameTree }>('Page.getFrameTree');
    this.#virtualTimersWorld = { frameId: frameTree.frame.id, executionContextId: await this.#isolatedWorld(frameTree.frame.id) };
    return this.#virtualTimersWorld;
  }

  async navigate(url: string, timeoutMilliseconds: number, scripts: 'enabled' | 'disabled'): Promise<void> {
    const frameId = this.#frame?.world.frameId;
    // Script execution is a setting of the whole page, so only the top document's navigate changes
    // it; it stays as set until the next one.
    if (frameId === undefined) {
      const disable = scripts === 'disabled';
      if (disable !== this.#scriptsDisabled) {
        await this.#send('Emulation.setScriptExecutionDisabled', { value: disable });
        this.#scriptsDisabled = disable;
      }
      this.#scriptsOffWorld = null;
      this.#virtualTimersWorld = null;
    }
    // The top document has loaded at its load event; a frame once it stops loading.
    const loaded = frameId === undefined
      ? this.#connection.once(this.#sessionId, 'Page.loadEventFired', timeoutMilliseconds)
      : this.#frameStoppedLoading(frameId, timeoutMilliseconds);
    loaded.promise.catch(() => undefined);
    try {
      const navigated = await this.#send<{ errorText?: string }>('Page.navigate', { url, ...(frameId === undefined ? {} : { frameId }) });
      // An HTTP error status with an empty body is a page the server did send: the browser shows
      // its own error page for it, and the plan's checks decide what that means.
      if (navigated.errorText && navigated.errorText !== HTTP_ERROR_STATUS) throw new Error(navigated.errorText);
      await loaded.promise;
    } finally {
      loaded.cancel();
    }
    if (frameId === undefined && this.#scriptsDisabled) {
      const { frameTree } = await this.#send<{ frameTree: FrameTree }>('Page.getFrameTree');
      this.#scriptsOffWorld = { frameId: frameTree.frame.id, executionContextId: await this.#isolatedWorld(frameTree.frame.id) };
    }
  }

  #frameStoppedLoading(frameId: string, timeoutMilliseconds: number): { readonly promise: Promise<unknown>; cancel(): void } {
    let stopListening = (): void => undefined;
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<unknown>((resolveLoaded, reject) => {
      stopListening = this.#connection.on(this.#sessionId, 'Page.frameStoppedLoading', (parameters) => {
        if ((parameters as { frameId?: string }).frameId !== frameId) return;
        clearTimeout(timer);
        stopListening();
        resolveLoaded(parameters);
      });
      timer = setTimeout(() => { stopListening(); reject(new Error(`the frame did not load within ${timeoutMilliseconds} ms`)); }, timeoutMilliseconds);
    });
    return { promise, cancel: () => { clearTimeout(timer); stopListening(); } };
  }

  // The document object: in the page's main world, or in this document's isolated world when it
  // has one. A frame that has navigated since has lost its world, so a new one is made.
  async #documentObject(): Promise<string> {
    const world = await this.#readingWorld();
    let evaluated: CallResult;
    if (world === null) {
      evaluated = await this.#send<CallResult>('Runtime.evaluate', { expression: 'document' });
    } else {
      try {
        evaluated = await this.#send<CallResult>('Runtime.evaluate', { expression: 'document', contextId: world.executionContextId });
      } catch (error) {
        if (!LOST_CONTEXT.test(errorText(error)) || this.#watch.crashed()) throw error;
        world.executionContextId = await this.#isolatedWorld(world.frameId);
        evaluated = await this.#send<CallResult>('Runtime.evaluate', { expression: 'document', contextId: world.executionContextId });
      }
    }
    if (evaluated.result.objectId === undefined) throw new Error('no document');
    return evaluated.result.objectId;
  }

  async #isolatedWorld(frameId: string): Promise<number> {
    const created = await this.#send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: FRAME_WORLD_NAME });
    return created.executionContextId;
  }

  async #call(pageFunction: PageFunction, inputs: readonly PageArgument<string>[], returnByValue: boolean): Promise<CallResult> {
    const objectId = await this.#documentObject();
    const callArguments: CallArgument[] = inputs.map((input) =>
      (typeof input === 'object' && input !== null && 'element' in input ? { objectId: input.element } : { value: input }));
    const called = await this.#send<CallResult>('Runtime.callFunctionOn', {
      functionDeclaration: pageFunction.toString(), objectId, arguments: callArguments, awaitPromise: true, returnByValue,
    });
    if (called.exceptionDetails) throw new Error(`page exception: ${called.exceptionDetails.exception?.value ?? called.exceptionDetails.text}`);
    return called;
  }

  async callForString(pageFunction: PageFunction, inputs: readonly PageArgument<string>[]): Promise<string> {
    return String((await this.#call(pageFunction, inputs, true)).result.value ?? '');
  }

  async callForElements(pageFunction: PageFunction, inputs: readonly PageArgument<string>[]): Promise<string[]> {
    const list = (await this.#call(pageFunction, inputs, false)).result.objectId;
    if (list === undefined) return [];
    const properties = await this.#send<{ result: { name: string; value?: { objectId?: string } }[] }>('Runtime.getProperties', { objectId: list, ownProperties: true });
    return properties.result
      .filter((property) => /^\d+$/.test(property.name))
      .flatMap((property) => (property.value?.objectId ? [property.value.objectId] : []));
  }

  async byRole(role: string, name: string): Promise<string[]> {
    const world = await this.#readingWorld();
    // Through a world, the document object comes first: reading it makes the world again if the
    // document has changed since, before the matches are resolved in it.
    const root = world === null
      ? (await this.#send<{ root: { backendNodeId: number } }>('DOM.getDocument', { depth: 0 })).root.backendNodeId
      : (await this.#send<DescribedNode>('DOM.describeNode', { objectId: await this.#documentObject() })).node.backendNodeId;
    const queried = await this.#send<{ nodes: AccessibilityNode[] }>('Accessibility.queryAXTree', {
      backendNodeId: root, role: role === 'img' ? 'image' : role, accessibleName: name,
    });
    const handles: string[] = [];
    for (const node of queried.nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue;
      const resolved = await this.#send<{ object: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId: node.backendDOMNodeId, ...(world === null ? {} : { executionContextId: world.executionContextId }),
      });
      if (resolved.object.objectId) handles.push(resolved.object.objectId);
    }
    return handles;
  }

  async roleAndName(element: string): Promise<RoleAndName> {
    const { nodes } = await this.#send<{ nodes: AccessibilityNode[] }>('Accessibility.getPartialAXTree', { objectId: element, fetchRelatives: false });
    const node = nodes[0];
    if (node === undefined || node.ignored) return { role: null, name: null };
    const role = typeof node.role?.value === 'string' && node.role.value !== '' ? node.role.value : null;
    const name = typeof node.name?.value === 'string' && node.name.value !== '' ? node.name.value : null;
    return { role: role === null ? null : ROLE_NAMES[role] ?? role, name };
  }

  async exposedStates(element: string): Promise<ExposedStates> {
    const { nodes } = await this.#send<{ nodes: AccessibilityNode[] }>('Accessibility.getPartialAXTree', { objectId: element, fetchRelatives: false });
    const properties = nodes[0]?.properties ?? [];
    const read = (name: (typeof EXPOSED_STATE_PROPERTIES)[number]): boolean | null => {
      const property = properties.find((candidate) => candidate.name === name);
      return property === undefined ? null : stateValue(property.value.value);
    };
    return { selected: read('selected'), expanded: read('expanded'), pressed: read('pressed') };
  }

  async accessibilityTree(): Promise<A11yNode> {
    const frameId = this.#frame?.world.frameId;
    const { nodes } = await this.#send<{ nodes: AccessibilityNode[] }>('Accessibility.getFullAXTree', frameId === undefined ? {} : { frameId });
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const build = (node: AccessibilityNode): A11yNode[] => {
      const children = (node.childIds ?? []).flatMap((id) => { const child = byId.get(id); return child ? build(child) : []; });
      const role = String(node.role?.value ?? 'none');
      if (node.ignored || TRANSPARENT_ROLES.has(role)) return children;
      return [{ role: ROLE_NAMES[role] ?? role, name: String(node.name?.value ?? ''), children }];
    };
    const root = nodes.find((node) => node.parentId === undefined) ?? nodes[0];
    const tree = root ? build(root) : [];
    return tree.length === 1 && tree[0] ? tree[0] : { role: 'document', name: '', children: tree };
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

  async click(_element: string, at: Point): Promise<void> {
    const offset = await this.#viewportOffset();
    const point = { x: at.x + offset.x, y: at.y + offset.y };
    const pressed = { ...point, button: 'left' as const, clickCount: 1 };
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await this.#untilDialog(this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pressed }));
    if (this.#watch.openDialog() !== null) return;
    await this.#untilDialog(this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pressed }));
  }

  async hover(at: Point): Promise<void> {
    const offset = await this.#viewportOffset();
    await this.#untilDialog(this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + offset.x, y: at.y + offset.y }));
  }

  async fill(element: string, value: string): Promise<void> {
    await this.callForString(focusAndSelect, [{ element }]);
    if (value === '') await this.#pressKey(KEY_DEFINITIONS.Backspace);
    else await this.#untilDialog(this.#send('Input.insertText', { text: value }));
  }

  async press(element: string, key: Key, modifiers: readonly HeldModifierKey[]): Promise<void> {
    await this.callForString(focusElement, [{ element }]);
    const held: HeldModifierKey[] = [];
    for (const modifier of modifiers) {
      held.push(modifier);
      const definition = MODIFIER_KEY_DEFINITIONS[modifier];
      await this.#untilDialog(this.#send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, location: LEFT_KEY, modifiers: modifierMask(held),
      }));
      if (this.#watch.openDialog() !== null) return;
    }
    await this.#pressKey(heldKeyDefinition(KEY_DEFINITIONS[key], held), modifierMask(held));
    for (const modifier of [...modifiers].reverse()) {
      if (this.#watch.openDialog() !== null) return;
      held.splice(held.indexOf(modifier), 1);
      const definition = MODIFIER_KEY_DEFINITIONS[modifier];
      await this.#untilDialog(this.#send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, location: LEFT_KEY, modifiers: modifierMask(held),
      }));
    }
  }

  async #pressKey(definition: KeyDefinition, modifiers = 0): Promise<void> {
    const common = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode, modifiers };
    await this.#untilDialog(this.#send('Input.dispatchKeyEvent', {
      type: definition.text ? 'keyDown' : 'rawKeyDown', ...common, ...(definition.text ? { text: definition.text } : {}),
    }));
    if (this.#watch.openDialog() !== null) return;
    await this.#untilDialog(this.#send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }));
  }

  async setFiles(element: string, paths: readonly string[]): Promise<void> {
    await this.#send('DOM.setFileInputFiles', { files: [...paths], objectId: element });
  }

  async frame(element: string): Promise<PageOperations<string> | null> {
    const described = await this.#send<DescribedNode>('DOM.describeNode', { objectId: element });
    const frameId = described.node.frameId;
    if (frameId === undefined) return null;
    let executionContextId: number;
    try {
      executionContextId = await this.#isolatedWorld(frameId);
    } catch (error) {
      // A frame whose document runs in another renderer process has no world in this session.
      if (this.#watch.crashed()) throw error;
      return null;
    }
    return new CdpPage(this.#connection, this.#sessionId, this.#watch, { parent: this, frameElement: element, world: { frameId, executionContextId } });
  }

  async unreachableUrl(): Promise<string | null> {
    const { frameTree } = await this.#send<{ frameTree: FrameTree }>('Page.getFrameTree');
    const frameId = this.#frame?.world.frameId;
    const find = (tree: FrameTree): FrameTree | undefined =>
      (frameId === undefined || tree.frame.id === frameId ? tree : (tree.childFrames ?? []).map(find).find((found) => found !== undefined));
    return find(frameTree)?.frame.unreachableUrl ?? null;
  }

  async screenshotPng(): Promise<Uint8Array> {
    const captured = await this.#send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
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
