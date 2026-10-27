// The own CDP driver: launches Chromium itself and speaks the Chrome DevTools Protocol over a
// WebSocket, with no third-party automation library. See docs/specs/SPEC-06-cdp-driver.md.
import {
  determinismScript, deviceProfile, failure, success,
  type A11yNode, type Key, type SessionEnvironment, type Target,
} from '@revisum/contracts';
import { buildSession, errorText } from './browser-session.ts';
import { CdpConnection } from './cdp-connection.ts';
import { QUIET_CHROME_FLAGS } from './chrome-flags.ts';
import { launchChromium, type LaunchedChromium } from './chromium-launcher.ts';
import { focusAndSelect, focusElement } from './in-page.ts';
import type { DriverSession, OwnBrowserDriver, PageArgument, PageFunction, PageOperations, Point } from './page-operations.ts';

export const CDP_ADAPTER_VERSION = '0.1.0';
const COMMAND_TIMEOUT_MILLISECONDS = 30_000;
// Schemes the page may load without an allow-list check: they never reach the network.
const LOCAL_SCHEMES = ['data:', 'about:', 'blob:', 'chrome-error:'];

type KeyDefinition = { readonly key: string; readonly code: string; readonly keyCode: number; readonly text?: string };
const KEY_DEFINITIONS: { readonly [Name in Key]: KeyDefinition } = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
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

export type CdpDriverOptions = { readonly executablePath: string; readonly launchTimeoutMilliseconds?: number };

export function cdpDriver(options: CdpDriverOptions): OwnBrowserDriver {
  return {
    info: { id: 'cdp', version: CDP_ADAPTER_VERSION, protocol: 'Chrome DevTools Protocol (raw WebSocket)' },
    supports(target) {
      if (target.engine !== 'chromium') return failure({ reason: 'engine-not-supported', detail: 'CDP drives Chromium only' });
      return success(true);
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
        return success(await createSession(launched, target, environment));
      } catch (error) {
        await launched.stop();
        return failure({ reason: 'launch-failed', detail: errorText(error) });
      }
    },
  };
}

async function createSession(launched: LaunchedChromium, target: Target, environment: SessionEnvironment): Promise<DriverSession> {
  const connection = launched.connection;
  const version = await connection.send<{ product: string; userAgent: string }>(undefined, 'Browser.getVersion');
  const { browserContextId } = await connection.send<{ browserContextId: string }>(undefined, 'Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await connection.send<{ targetId: string }>(undefined, 'Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await connection.send<{ sessionId: string }>(undefined, 'Target.attachToTarget', { targetId, flatten: true });
  const page = connection.session(sessionId);

  const profile = deviceProfile(target);
  await page.send('Page.enable');
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

  const operations = new CdpPage(connection, sessionId);
  return buildSession(operations, environment, {
    browser: { name: 'chromium', version: /\/(\S+)$/.exec(version.product)?.[1] ?? version.product },
    processId: launched.browserProcess.pid ?? -1,
    blockedOrigins: () => blocked,
    close: () => launched.stop(),
  });
}

// PageOperations over one flat CDP session. Element handles are remote object ids.
class CdpPage implements PageOperations<string> {
  readonly protocol = 'cdp' as const;
  readonly accessibilityTreeSource = 'browser' as const;
  readonly #connection: CdpConnection;
  readonly #sessionId: string;

  constructor(connection: CdpConnection, sessionId: string) {
    this.#connection = connection;
    this.#sessionId = sessionId;
  }

  #send<Value = Record<string, unknown>>(method: string, parameters: Record<string, unknown> = {}): Promise<Value> {
    return this.#connection.send<Value>(this.#sessionId, method, parameters);
  }

  async navigate(url: string, timeoutMilliseconds: number): Promise<void> {
    const loaded = this.#connection.once(this.#sessionId, 'Page.loadEventFired', timeoutMilliseconds);
    loaded.promise.catch(() => undefined);
    try {
      const navigated = await this.#send<{ errorText?: string }>('Page.navigate', { url });
      if (navigated.errorText) throw new Error(navigated.errorText);
      await loaded.promise;
    } finally {
      loaded.cancel();
    }
  }

  async #documentObject(): Promise<string> {
    const evaluated = await this.#send<CallResult>('Runtime.evaluate', { expression: 'document' });
    if (evaluated.result.objectId === undefined) throw new Error('no document');
    return evaluated.result.objectId;
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
    const documentNode = await this.#send<{ root: { backendNodeId: number } }>('DOM.getDocument', { depth: 0 });
    const queried = await this.#send<{ nodes: AccessibilityNode[] }>('Accessibility.queryAXTree', {
      backendNodeId: documentNode.root.backendNodeId, role: role === 'img' ? 'image' : role, accessibleName: name,
    });
    const handles: string[] = [];
    for (const node of queried.nodes) {
      if (node.ignored || node.backendDOMNodeId === undefined) continue;
      const resolved = await this.#send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
      if (resolved.object.objectId) handles.push(resolved.object.objectId);
    }
    return handles;
  }

  async accessibilityTree(): Promise<A11yNode> {
    const { nodes } = await this.#send<{ nodes: AccessibilityNode[] }>('Accessibility.getFullAXTree');
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

  async click(_element: string, at: Point): Promise<void> {
    const pressed = { x: at.x, y: at.y, button: 'left' as const, clickCount: 1 };
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pressed });
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pressed });
  }

  async fill(element: string, value: string): Promise<void> {
    await this.callForString(focusAndSelect, [{ element }]);
    if (value === '') await this.#pressKey(KEY_DEFINITIONS.Backspace);
    else await this.#send('Input.insertText', { text: value });
  }

  async press(element: string, key: Key): Promise<void> {
    await this.callForString(focusElement, [{ element }]);
    await this.#pressKey(KEY_DEFINITIONS[key]);
  }

  async #pressKey(definition: KeyDefinition): Promise<void> {
    const common = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode };
    await this.#send('Input.dispatchKeyEvent', { type: definition.text ? 'keyDown' : 'rawKeyDown', ...common, ...(definition.text ? { text: definition.text } : {}) });
    await this.#send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  async screenshotPng(): Promise<Uint8Array> {
    const captured = await this.#send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return new Uint8Array(Buffer.from(captured.data, 'base64'));
  }
}
