// The own CDP driver: launches Chromium itself and speaks the Chrome DevTools Protocol over a
// WebSocket, with no third-party automation library. See docs/specs/SPEC-06-cdp-driver.md.
import {
  determinismScript, deviceProfile, failure, success,
  type A11yNode, type DriverError, type Key, type Result, type SessionEnvironment, type Target,
} from '@revisum/contracts';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { chromiumBuild } from './browser-build.ts';
import { buildSession, errorText } from './browser-session.ts';
import { CdpConnection } from './cdp-connection.ts';
import { QUIET_CHROME_FLAGS } from './chrome-flags.ts';
import { launchChromium, type LaunchedChromium } from './chromium-launcher.ts';
import { focusAndSelect, focusElement, frameContentOffset } from './in-page.ts';
import type { DriverSession, OwnBrowserDriver, PageArgument, PageFunction, PageOperations, Point, RoleAndName } from './page-operations.ts';
import { PageWatch } from './page-watch.ts';

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
// Chromium-internal roles mapped to ARIA roles, and structural roles left out of snapshots.
const ROLE_NAMES: Readonly<Record<string, string>> = { RootWebArea: 'document', image: 'img', LabelText: 'label' };
const TRANSPARENT_ROLES = new Set(['none', 'generic', 'StaticText', 'InlineTextBox', 'LineBreak', 'ignored', 'presentation']);

// Chrome DevTools Protocol shapes this driver reads.
type RemoteObject = { readonly type: string; readonly subtype?: string; readonly value?: unknown; readonly objectId?: string };
type CallResult = { readonly result: RemoteObject; readonly exceptionDetails?: { readonly text: string; readonly exception?: RemoteObject } };
type CallArgument = { readonly value?: unknown; readonly objectId?: string };
type AccessibilityValue = { readonly type: string; readonly value?: unknown };
type AccessibilityNode = {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly role?: AccessibilityValue;
  readonly name?: AccessibilityValue;
  readonly childIds?: readonly string[];
  readonly parentId?: string;
  readonly backendDOMNodeId?: number;
};
type RequestPaused = { readonly requestId: string; readonly request: { readonly url: string } };
type DescribedNode = { readonly node: { readonly backendNodeId: number; readonly frameId?: string } };

export type CdpDriverOptions = {
  readonly executablePath: string;
  readonly launchTimeoutMilliseconds?: number;
  // The project's fixtures folder. An upload step sends a declared fixture from here, and never a
  // file outside it. Without it, the driver refuses every upload.
  readonly fixturesFolder?: string;
};

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
      let launched: LaunchedChromium;
      try {
        launched = await launchChromium(options.executablePath, {
          arguments: [...QUIET_CHROME_FLAGS, `--lang=${target.locale}`],
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

async function createSession(
  launched: LaunchedChromium, target: Target, environment: SessionEnvironment, fixturesFolder: string | undefined,
): Promise<DriverSession> {
  const connection = launched.connection;
  const version = await connection.send<{ product: string; userAgent: string }>(undefined, 'Browser.getVersion');
  const { browserContextId } = await connection.send<{ browserContextId: string }>(undefined, 'Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await connection.send<{ targetId: string }>(undefined, 'Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await connection.send<{ sessionId: string }>(undefined, 'Target.attachToTarget', { targetId, flatten: true });
  const page = connection.session(sessionId);

  const profile = deviceProfile(target);
  await page.send('Page.enable');
  const watch = new PageWatch(connection, { browserContextId, targetId, sessionId });
  await watch.start();
  await page.send('Emulation.setDeviceMetricsOverride', { width: profile.width, height: profile.height, deviceScaleFactor: profile.scale, mobile: profile.mobile });
  // The quoted key is the protocol's own parameter name.
  if (profile.touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, 'maxTouchPoints': 5 });
  await page.send('Emulation.setLocaleOverride', { locale: target.locale });
  await page.send('Emulation.setTimezoneOverride', { timezoneId: target.timezone });
  // navigator.language follows Accept-Language, so the locale needs both overrides.
  await page.send('Emulation.setUserAgentOverride', { userAgent: version.userAgent, acceptLanguage: target.locale });
  await page.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-motion', value: target.reducedMotion },
    { name: 'prefers-color-scheme', value: target.colorScheme },
  ] });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: determinismScript(environment.seed, environment.fixedTimeMilliseconds) });

  // Every request is paused and either let through (allowed origin) or failed and recorded.
  const blocked: string[] = [];
  page.on('Fetch.requestPaused', (parameters) => {
    const paused = parameters as RequestPaused;
    let allowed = false;
    try {
      const url = new URL(paused.request.url);
      allowed = environment.allowedOrigins.includes(url.origin) || LOCAL_SCHEMES.includes(url.protocol);
      if (!allowed) blocked.push(url.origin);
    } catch { /* a URL that cannot be parsed is blocked */ }
    const decision = allowed
      ? page.send('Fetch.continueRequest', { requestId: paused.requestId })
      : page.send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'BlockedByClient' });
    decision.catch(() => undefined);
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

  const operations = new CdpPage(connection, sessionId, watch, null);
  return buildSession(operations, environment, {
    browser: { name: 'chromium', version: /\/(\S+)$/.exec(version.product)?.[1] ?? version.product },
    processId: launched.browserProcess.pid ?? -1,
    blockedOrigins: () => blocked,
    close: () => launched.stop(),
    events: watch,
    fixturePath: (fixture) => fixtureFilePath(fixturesFolder, fixture),
  });
}

// Where a CdpPage's document is when it is an iframe's: the frame's id, its element in the parent
// document, and the isolated script world it is read through. The page's own scripts cannot see
// or change that world; it shares only the document.
type FrameScope = {
  readonly parent: CdpPage;
  readonly frameElement: string;
  readonly frameId: string;
  executionContextId: number;
};

// The name of the isolated script world the driver reads a frame's document through.
const FRAME_WORLD_NAME = 'driver-frame';
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

  constructor(connection: CdpConnection, sessionId: string, watch: PageWatch, frame: FrameScope | null) {
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.#watch = watch;
    this.#frame = frame;
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

  async navigate(url: string, timeoutMilliseconds: number): Promise<void> {
    const frameId = this.#frame?.frameId;
    // The top document has loaded at its load event; a frame once it stops loading.
    const loaded = frameId === undefined
      ? this.#connection.once(this.#sessionId, 'Page.loadEventFired', timeoutMilliseconds)
      : this.#frameStoppedLoading(frameId, timeoutMilliseconds);
    loaded.promise.catch(() => undefined);
    try {
      const navigated = await this.#send<{ errorText?: string }>('Page.navigate', { url, ...(frameId === undefined ? {} : { frameId }) });
      if (navigated.errorText) throw new Error(navigated.errorText);
      await loaded.promise;
    } finally {
      loaded.cancel();
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

  // The document object: the top document's, in the page's main world, or the frame's, in its
  // isolated world. A frame that has navigated since has lost its world, so a new one is made.
  async #documentObject(): Promise<string> {
    const frame = this.#frame;
    let evaluated: CallResult;
    if (frame === null) {
      evaluated = await this.#send<CallResult>('Runtime.evaluate', { expression: 'document' });
    } else {
      try {
        evaluated = await this.#send<CallResult>('Runtime.evaluate', { expression: 'document', contextId: frame.executionContextId });
      } catch (error) {
        if (!LOST_CONTEXT.test(errorText(error)) || this.#watch.crashed()) throw error;
        frame.executionContextId = await this.#isolatedWorld(frame.frameId);
        evaluated = await this.#send<CallResult>('Runtime.evaluate', { expression: 'document', contextId: frame.executionContextId });
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
    const frame = this.#frame;
    const root = frame === null
      ? (await this.#send<{ root: { backendNodeId: number } }>('DOM.getDocument', { depth: 0 })).root.backendNodeId
      : (await this.#send<DescribedNode>('DOM.describeNode', { objectId: await this.#documentObject() })).node.backendNodeId;
    const queried = await this.#send<{ nodes: AccessibilityNode[] }>('Accessibility.queryAXTree', {
      backendNodeId: root, role: role === 'img' ? 'image' : role, accessibleName: name,
    });
    const handles: string[] = [];
    for (const node of queried.nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue;
      const resolved = await this.#send<{ object: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId: node.backendDOMNodeId, ...(frame === null ? {} : { executionContextId: frame.executionContextId }),
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

  async accessibilityTree(): Promise<A11yNode> {
    const frameId = this.#frame?.frameId;
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

  async press(element: string, key: Key): Promise<void> {
    await this.callForString(focusElement, [{ element }]);
    await this.#pressKey(KEY_DEFINITIONS[key]);
  }

  async #pressKey(definition: KeyDefinition): Promise<void> {
    const common = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode };
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
    return new CdpPage(this.#connection, this.#sessionId, this.#watch, { parent: this, frameElement: element, frameId, executionContextId });
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
