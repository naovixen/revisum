// The browser and page the accessibility engine scans with: headless Chromium over driver-cdp's
// connection and launcher, with the network blocked outside 127.0.0.1.
import type { Box } from '@revisum/contracts';
import {
  ATTACH_TO_TARGET, BRING_TO_FRONT, CALL_FUNCTION_ON, CAPTURE_SCREENSHOT, CLOSE_TARGET, CONTINUE_REQUEST, CREATE_TARGET, DESCRIBE_NODE, DISPATCH_KEY_EVENT, ENABLE_ACCESSIBILITY, ENABLE_CSS, ENABLE_DOM, ENABLE_PAGE, ENABLE_REQUEST_HOLDING,
  ENABLE_RUNTIME, EVALUATE, FAIL_REQUEST, GET_DOCUMENT, GET_FRAME_TREE, GET_MATCHED_STYLES, GET_VERSION, NAVIGATE, PUSH_NODES_BY_BACKEND_IDS, RELEASE_OBJECT, REQUEST_PAUSED, RESOLVE_NODE, SET_DEVICE_METRICS, SET_FOCUS_EMULATION,
  launchChromium, type CdpConnection, type CdpSessionClient, type LaunchedChromium,
} from '@revisum/driver-cdp';
import type { Browser, PageDriver, PageKey, PageSnapshot } from './accessibility-types.ts';
import { buildSnapshot } from './page-snapshot.ts';
import { decodePng, extremes } from './png-reader.ts';

export const SCAN_VIEWPORT = { width: 1024, height: 768 } as const;
const KEY_CODES: Record<PageKey, { code: string; virtualKeyCode: number }> = {
  Tab: { code: 'Tab', virtualKeyCode: 9 },
  Escape: { code: 'Escape', virtualKeyCode: 27 },
  Enter: { code: 'Enter', virtualKeyCode: 13 },
};
// Two animation frames and a short timer, so blur and focus handlers and timeouts run.
const SETTLE = `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))`;

// The deepest active element across shadow roots and same-origin frames, with its box in page
// and in viewport coordinates.
const ACTIVE_ELEMENT_FUNCTION = `function () {
  let ownerDocument = document, element = document.activeElement, offsetX = 0, offsetY = 0;
  for (;;) {
    if (!element) return null;
    if (element.shadowRoot && element.shadowRoot.activeElement) { element = element.shadowRoot.activeElement; continue; }
    if ((element.tagName === 'IFRAME' || element.tagName === 'FRAME') && element.contentDocument && element.contentDocument.activeElement) {
      const frame = element.getBoundingClientRect(); offsetX += frame.left + element.clientLeft; offsetY += frame.top + element.clientTop;
      ownerDocument = element.contentDocument; element = ownerDocument.activeElement;
      if (element === ownerDocument.body || element === ownerDocument.documentElement) return null;
      continue;
    }
    break;
  }
  if (element === document.body || element === document.documentElement) return null;
  const rectangle = element.getBoundingClientRect();
  return {
    element,
    box: [rectangle.left + offsetX + window.scrollX, rectangle.top + offsetY + window.scrollY, rectangle.width, rectangle.height],
    view: [rectangle.left + offsetX, rectangle.top + offsetY, rectangle.width, rectangle.height],
  };
}`;

// Hides the text of the element (so the background shows) and returns the text's page box.
const HIDE_TEXT_FUNCTION = `function () {
  const element = this.nodeType === 3 ? this.parentElement : this;
  const ownerDocument = element.ownerDocument;
  if (!ownerDocument.getElementById('contrast-sample-hide-style')) {
    const style = ownerDocument.createElement('style');
    style.id = 'contrast-sample-hide-style';
    style.textContent = '[data-contrast-sample-hide], [data-contrast-sample-hide] * { color: transparent !important; text-shadow: none !important; -webkit-text-stroke: 0 !important; caret-color: transparent !important; text-decoration-color: transparent !important; }';
    (ownerDocument.head || ownerDocument.documentElement).appendChild(style);
  }
  element.setAttribute('data-contrast-sample-hide', '');
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const range = ownerDocument.createRange();
  range.selectNodeContents(this);
  const rectangle = range.getBoundingClientRect();
  return [rectangle.left + window.scrollX, rectangle.top + window.scrollY, rectangle.width, rectangle.height];
}`;
const SHOW_TEXT_FUNCTION = `function () {
  const element = this.nodeType === 3 ? this.parentElement : this;
  element.removeAttribute('data-contrast-sample-hide');
  const style = element.ownerDocument.getElementById('contrast-sample-hide-style');
  if (style) style.remove();
}`;

// How a command fails when the page, its request or the browser has already gone, which leaves nothing
// to clean up.
const ALREADY_GONE = /Invalid InterceptionId|Session with given id not found|No target with given id|Cannot find context|Could not find object|connection closed/i;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

const numbersIn = (value: unknown): readonly number[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'number') ? value : undefined;

const toBox = (values: readonly number[] | undefined): Box | null =>
  values?.length === 4 ? { x: values[0] ?? 0, y: values[1] ?? 0, width: values[2] ?? 0, height: values[3] ?? 0 } : null;

class ChromiumPage implements PageDriver {
  readonly #session: CdpSessionClient;
  readonly #connection: CdpConnection;
  readonly #targetId: string;
  #allowedUrl = '';
  #mainFrame = '';
  #cssEnabled = false;
  // What went wrong outside any one call, for close to report.
  readonly #failures: string[] = [];

  constructor(connection: CdpConnection, session: CdpSessionClient, targetId: string) {
    this.#connection = connection;
    this.#session = session;
    this.#targetId = targetId;
  }

  async initialise(): Promise<void> {
    await this.#session.ask(ENABLE_PAGE, {});
    this.#mainFrame = (await this.#session.ask(GET_FRAME_TREE, {})).frameTree.frame.id;
    // Hold the scanned document: client-side redirects and refreshes of the main frame are aborted during a scan.
    this.#session.listen(REQUEST_PAUSED, (paused) => {
      const leaving = paused.resourceType === 'Document' && paused.frameId === this.#mainFrame && this.#allowedUrl !== ''
        && paused.request.url.split('#')[0] !== this.#allowedUrl.split('#')[0];
      const decision = leaving
        ? this.#session.ask(FAIL_REQUEST, { requestId: paused.requestId, errorReason: 'Aborted' })
        : this.#session.ask(CONTINUE_REQUEST, { requestId: paused.requestId });
      decision.catch((error: unknown) => { this.#noteCleanUpFailure('a held document could not be decided on', error); });
    }, (detail) => { this.#failures.push(`a held document could not be read: ${detail}`); });
    await this.#session.ask(ENABLE_REQUEST_HOLDING, { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    await this.#session.ask(ENABLE_RUNTIME, {});
    await this.#session.ask(ENABLE_DOM, {});
    await this.#session.ask(ENABLE_ACCESSIBILITY, {});
    await this.setViewport(SCAN_VIEWPORT.width, SCAN_VIEWPORT.height);
    // The page keeps focus even when another page is active.
    await this.#session.ask(SET_FOCUS_EMULATION, { enabled: true });
  }

  #noteCleanUpFailure(doing: string, error: unknown): void {
    if (!ALREADY_GONE.test(errorText(error))) {
      this.#failures.push(`${doing}: ${errorText(error)}`);
    }
  }

  async goto(url: string, timeoutMilliseconds = 20_000): Promise<void> {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stopListening(); reject(new Error('load timeout ' + url)); }, timeoutMilliseconds);
      const stopListening = this.#session.on('Page.loadEventFired', () => { clearTimeout(timer); stopListening(); resolve(); });
    });
    this.#allowedUrl = url;
    await this.#session.ask(BRING_TO_FRONT, {});
    const navigated = await this.#session.ask(NAVIGATE, { url }, timeoutMilliseconds);
    if (navigated.errorText !== undefined && navigated.errorText !== '') throw new Error(`navigate ${url}: ${navigated.errorText}`);
    await loaded;
    await this.evaluate(`document.fonts ? document.fonts.ready.then(() => ${SETTLE}) : ${SETTLE}`);
  }

  snapshot(): Promise<PageSnapshot> { return buildSnapshot(this.#session); }

  async pressKey(key: PageKey, shift = false): Promise<void> {
    const codes = KEY_CODES[key];
    const event = { key, code: codes.code, windowsVirtualKeyCode: codes.virtualKeyCode, nativeVirtualKeyCode: codes.virtualKeyCode, modifiers: shift ? 8 : 0 };
    await this.#session.ask(DISPATCH_KEY_EVENT, { type: 'rawKeyDown', ...event });
    await this.#session.ask(DISPATCH_KEY_EVENT, { type: 'keyUp', ...event });
    await this.evaluate(SETTLE);
  }

  async activeElement(): Promise<{ backendId: number; box: Box | null } | null> {
    const found = await this.#session.ask(EVALUATE, { expression: `(${ACTIVE_ELEMENT_FUNCTION})()`, returnByValue: false });
    const holder = found.result;
    if (holder.subtype === 'null' || holder.objectId === undefined) return null;
    const boxes = await this.#session.ask(CALL_FUNCTION_ON, {
      objectId: holder.objectId, functionDeclaration: 'function(){return [this.box, this.view]}', returnByValue: true,
    });
    const element = await this.#session.ask(CALL_FUNCTION_ON, {
      objectId: holder.objectId, functionDeclaration: 'function(){return this.element}', returnByValue: false,
    });
    if (element.result.objectId === undefined) return null;
    const described = await this.#session.ask(DESCRIBE_NODE, { objectId: element.result.objectId });
    await this.#session.ask(RELEASE_OBJECT, { objectId: holder.objectId });
    await this.#session.ask(RELEASE_OBJECT, { objectId: element.result.objectId });
    const measured: unknown = boxes.result.value;
    const pageBox: unknown = Array.isArray(measured) ? measured[0] : undefined;
    return { backendId: described.node.backendNodeId, box: toBox(numbersIn(pageBox)) };
  }

  // The clip is in page coordinates.
  async screenshotClip(clip: Box): Promise<string> {
    const captured = await this.#session.ask(CAPTURE_SCREENSHOT, {
      format: 'png',
      clip: { x: clip.x, y: clip.y, width: Math.max(1, clip.width), height: Math.max(1, clip.height), scale: 1 },
      captureBeyondViewport: false, fromSurface: true,
    });
    return captured.data;
  }

  async screenshot(): Promise<string> {
    const captured = await this.#session.ask(CAPTURE_SCREENSHOT, { format: 'png', fromSurface: true, captureBeyondViewport: false });
    return captured.data;
  }

  async authorDeclaredProperties(backendId: number): Promise<string[]> {
    await this.#session.ask(GET_DOCUMENT, { depth: 0 });
    if (!this.#cssEnabled) {
      await this.#session.ask(ENABLE_CSS, {});
      this.#cssEnabled = true;
    }
    const { nodeIds } = await this.#session.ask(PUSH_NODES_BY_BACKEND_IDS, { backendNodeIds: [backendId] });
    const nodeId = nodeIds[0];
    if (nodeId === undefined || nodeId === 0) return [];
    const matched = await this.#session.ask(GET_MATCHED_STYLES, { nodeId });
    const declared = new Set<string>();
    for (const declaration of matched.inlineStyle ?? []) if (declaration.value !== '') declared.add(declaration.name);
    for (const matchedRule of matched.matchedCSSRules ?? []) {
      if (matchedRule.origin !== 'regular' && matchedRule.origin !== 'inspector') continue;
      for (const declaration of matchedRule.declarations) if (declaration.value !== '') declared.add(declaration.name);
    }
    return [...declared].sort();
  }

  async focusBackend(backendId: number): Promise<boolean> {
    try {
      const { object } = await this.#session.ask(RESOLVE_NODE, { backendNodeId: backendId });
      const focused = await this.#session.ask(CALL_FUNCTION_ON, {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: 'function(){ this.focus(); return this.getRootNode().activeElement === this || document.activeElement === this; }',
      });
      await this.#session.ask(RELEASE_OBJECT, { objectId: object.objectId });
      await this.evaluate(SETTLE);
      return focused.result.value === true;
    } catch {
      return false;
    }
  }

  async sampleBackground(textBackendId: number): Promise<{ dark: [number, number, number]; light: [number, number, number] } | null> {
    let objectId: string | undefined;
    try {
      objectId = (await this.#session.ask(RESOLVE_NODE, { backendNodeId: textBackendId })).object.objectId;
      const hidden = await this.#session.ask(CALL_FUNCTION_ON, { objectId, returnByValue: true, functionDeclaration: HIDE_TEXT_FUNCTION });
      await this.evaluate(SETTLE);
      const [x, y, width, height] = numbersIn(hidden.result.value) ?? [];
      if (x === undefined || y === undefined || width === undefined || width === 0 || height === undefined || height === 0) return null;
      const shot = await this.screenshotClip({ x: Math.floor(x), y: Math.floor(y), width: Math.max(1, Math.ceil(width)), height: Math.max(1, Math.ceil(height)) });
      return extremes(decodePng(Buffer.from(shot, 'base64')));
    } catch {
      return null;
    } finally {
      if (objectId !== undefined) {
        await this.#session.ask(CALL_FUNCTION_ON, { objectId, functionDeclaration: SHOW_TEXT_FUNCTION }).catch((error: unknown) => { this.#noteCleanUpFailure('hidden text could not be shown again', error); });
        await this.#session.ask(RELEASE_OBJECT, { objectId }).catch((error: unknown) => { this.#noteCleanUpFailure('a sampled node could not be released', error); });
      }
    }
  }

  async evaluate<Value>(expression: string): Promise<Value> {
    const evaluated = await this.#session.ask(EVALUATE, { expression, returnByValue: true, awaitPromise: true });
    if (evaluated.exceptionDetails !== undefined) throw new Error('evaluate: ' + (evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text));
    return evaluated.result.value as Value;
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.#session.ask(SET_DEVICE_METRICS, { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async close(): Promise<void> {
    await this.#connection.ask(undefined, CLOSE_TARGET, { targetId: this.#targetId }).catch((error: unknown) => { this.#noteCleanUpFailure('a page could not be closed', error); });
    if (this.#failures.length > 0) {
      throw new Error(this.#failures.join('; '));
    }
  }
}

class ChromiumBrowser implements Browser {
  readonly version: string;
  readonly #launched: LaunchedChromium;
  #hasExited = false;

  constructor(launched: LaunchedChromium, version: string) {
    this.#launched = launched;
    this.version = version;
    launched.browserProcess.on('exit', () => { this.#hasExited = true; });
    launched.browserProcess.on('close', () => { this.#hasExited = true; });
  }

  async newPage(): Promise<PageDriver> {
    // Each page gets its own window: background tabs throttle animation frames and screenshots.
    const connection = this.#launched.connection;
    const { targetId } = await connection.ask(undefined, CREATE_TARGET, { url: 'about:blank', newWindow: true });
    const { sessionId } = await connection.ask(undefined, ATTACH_TO_TARGET, { targetId, flatten: true });
    const page = new ChromiumPage(connection, connection.session(sessionId), targetId);
    await page.initialise();
    return page;
  }

  exited(): boolean {
    const process = this.#launched.browserProcess;
    return this.#hasExited || process.exitCode !== null || process.signalCode !== null;
  }

  async close(): Promise<void> {
    await this.#launched.stop();
  }
}

// Launches headless Chromium for scanning: no network outside 127.0.0.1.
export async function launchBrowser(executablePath: string): Promise<Browser> {
  const launched = await launchChromium(executablePath, { profilePrefix: 'accessibility-scan-' });
  const version = await launched.connection.ask(undefined, GET_VERSION, {});
  return new ChromiumBrowser(launched, version.product);
}
