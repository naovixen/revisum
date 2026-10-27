// The browser and page the accessibility engine scans with: headless Chromium over driver-cdp's
// connection and launcher, with the network blocked outside 127.0.0.1.
import type { Box } from '@revisum/contracts';
import { launchChromium, type CdpConnection, type CdpSessionClient, type LaunchedChromium } from '@revisum/driver-cdp';
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

interface RemoteObject { objectId?: string; value?: unknown; type: string; subtype?: string }
interface EvaluateResult { result: RemoteObject; exceptionDetails?: { text: string; exception?: { description?: string } } }

const toBox = (values: number[] | undefined): Box | null =>
  values && values.length === 4 ? { x: values[0] ?? 0, y: values[1] ?? 0, width: values[2] ?? 0, height: values[3] ?? 0 } : null;

class ChromiumPage implements PageDriver {
  private readonly session: CdpSessionClient;
  private readonly connection: CdpConnection;
  private readonly targetId: string;
  private allowedUrl = '';
  private mainFrame = '';
  private cssEnabled = false;

  constructor(connection: CdpConnection, session: CdpSessionClient, targetId: string) {
    this.connection = connection;
    this.session = session;
    this.targetId = targetId;
  }

  async initialise(): Promise<void> {
    await this.session.send('Page.enable');
    this.mainFrame = (await this.session.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')).frameTree.frame.id;
    // Hold the scanned document: client-side redirects and refreshes of the main frame are aborted during a scan.
    this.session.on('Fetch.requestPaused', (parameters) => {
      const paused = parameters as { requestId: string; frameId?: string; request: { url: string }; resourceType: string };
      const leaving = paused.resourceType === 'Document' && paused.frameId === this.mainFrame && this.allowedUrl !== ''
        && paused.request.url.split('#')[0] !== this.allowedUrl.split('#')[0];
      const decision = leaving
        ? this.session.send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'Aborted' })
        : this.session.send('Fetch.continueRequest', { requestId: paused.requestId });
      void decision.catch(() => undefined);
    });
    await this.session.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    await this.session.send('Runtime.enable');
    await this.session.send('DOM.enable');
    await this.session.send('Accessibility.enable');
    await this.setViewport(SCAN_VIEWPORT.width, SCAN_VIEWPORT.height);
    // The page keeps focus even when another page is active.
    await this.session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }

  async goto(url: string, timeoutMilliseconds = 20_000): Promise<void> {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stopListening(); reject(new Error('load timeout ' + url)); }, timeoutMilliseconds);
      const stopListening = this.session.on('Page.loadEventFired', () => { clearTimeout(timer); stopListening(); resolve(); });
    });
    this.allowedUrl = url;
    await this.session.send('Page.bringToFront');
    const navigated = await this.session.send<{ errorText?: string }>('Page.navigate', { url }, timeoutMilliseconds);
    if (navigated.errorText) throw new Error(`navigate ${url}: ${navigated.errorText}`);
    await loaded;
    await this.evaluate(`document.fonts ? document.fonts.ready.then(() => ${SETTLE}) : ${SETTLE}`);
  }

  snapshot(): Promise<PageSnapshot> { return buildSnapshot(this.session); }

  async pressKey(key: PageKey, shift = false): Promise<void> {
    const codes = KEY_CODES[key];
    const event = { key, code: codes.code, windowsVirtualKeyCode: codes.virtualKeyCode, nativeVirtualKeyCode: codes.virtualKeyCode, modifiers: shift ? 8 : 0 };
    await this.session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
    await this.evaluate(SETTLE);
  }

  async activeElement(): Promise<{ backendId: number; box: Box | null } | null> {
    const found = await this.session.send<EvaluateResult>('Runtime.evaluate', { expression: `(${ACTIVE_ELEMENT_FUNCTION})()`, returnByValue: false });
    const holder = found.result;
    if (holder.subtype === 'null' || !holder.objectId) return null;
    const boxes = await this.session.send<EvaluateResult>('Runtime.callFunctionOn', {
      objectId: holder.objectId, functionDeclaration: 'function(){return [this.box, this.view]}', returnByValue: true,
    });
    const element = await this.session.send<EvaluateResult>('Runtime.callFunctionOn', {
      objectId: holder.objectId, functionDeclaration: 'function(){return this.element}', returnByValue: false,
    });
    if (!element.result.objectId) return null;
    const described = await this.session.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: element.result.objectId });
    await this.session.send('Runtime.releaseObject', { objectId: holder.objectId });
    await this.session.send('Runtime.releaseObject', { objectId: element.result.objectId });
    const [pageBox] = boxes.result.value as [number[], number[]];
    return { backendId: described.node.backendNodeId, box: toBox(pageBox) };
  }

  // The clip is in page coordinates.
  async screenshotClip(clip: Box): Promise<string> {
    const captured = await this.session.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: { x: clip.x, y: clip.y, width: Math.max(1, clip.width), height: Math.max(1, clip.height), scale: 1 },
      captureBeyondViewport: false, fromSurface: true,
    });
    return captured.data;
  }

  async screenshot(): Promise<string> {
    const captured = await this.session.send<{ data: string }>('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    return captured.data;
  }

  async authorDeclaredProperties(backendId: number): Promise<string[]> {
    await this.session.send('DOM.getDocument', { depth: 0 });
    if (!this.cssEnabled) {
      await this.session.send('CSS.enable');
      this.cssEnabled = true;
    }
    const { nodeIds } = await this.session.send<{ nodeIds: number[] }>('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendId] });
    const nodeId = nodeIds[0];
    if (!nodeId) return [];
    type Declaration = { name: string; value: string };
    const matched = await this.session.send<{
      inlineStyle?: { cssProperties: Declaration[] };
      matchedCSSRules?: { rule: { origin: string; style: { cssProperties: Declaration[] } } }[];
    }>('CSS.getMatchedStylesForNode', { nodeId });
    const declared = new Set<string>();
    for (const declaration of matched.inlineStyle?.cssProperties ?? []) if (declaration.value) declared.add(declaration.name);
    for (const matchedRule of matched.matchedCSSRules ?? []) {
      if (matchedRule.rule.origin !== 'regular' && matchedRule.rule.origin !== 'inspector') continue;
      for (const declaration of matchedRule.rule.style.cssProperties) if (declaration.value) declared.add(declaration.name);
    }
    return [...declared].sort();
  }

  async focusBackend(backendId: number): Promise<boolean> {
    try {
      const { object } = await this.session.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: backendId });
      if (!object.objectId) return false;
      const focused = await this.session.send<EvaluateResult>('Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: 'function(){ this.focus(); return this.getRootNode().activeElement === this || document.activeElement === this; }',
      });
      await this.session.send('Runtime.releaseObject', { objectId: object.objectId });
      await this.evaluate(SETTLE);
      return focused.result.value === true;
    } catch {
      return false;
    }
  }

  async sampleBackground(textBackendId: number): Promise<{ dark: [number, number, number]; light: [number, number, number] } | null> {
    let objectId: string | undefined;
    try {
      objectId = (await this.session.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: textBackendId })).object.objectId;
      if (!objectId) return null;
      const hidden = await this.session.send<EvaluateResult>('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: HIDE_TEXT_FUNCTION });
      await this.evaluate(SETTLE);
      const [x, y, width, height] = hidden.result.value as number[];
      if (x === undefined || y === undefined || !width || !height) return null;
      const shot = await this.screenshotClip({ x: Math.floor(x), y: Math.floor(y), width: Math.max(1, Math.ceil(width)), height: Math.max(1, Math.ceil(height)) });
      return extremes(decodePng(Buffer.from(shot, 'base64')));
    } catch {
      return null;
    } finally {
      if (objectId) {
        await this.session.send('Runtime.callFunctionOn', { objectId, functionDeclaration: SHOW_TEXT_FUNCTION }).catch(() => undefined);
        await this.session.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
    }
  }

  async evaluate<Value>(expression: string): Promise<Value> {
    const evaluated = await this.session.send<EvaluateResult>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (evaluated.exceptionDetails) throw new Error('evaluate: ' + (evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text));
    return evaluated.result.value as Value;
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async close(): Promise<void> {
    await this.connection.send(undefined, 'Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }
}

class ChromiumBrowser implements Browser {
  readonly version: string;
  private readonly launched: LaunchedChromium;
  private hasExited = false;

  constructor(launched: LaunchedChromium, version: string) {
    this.launched = launched;
    this.version = version;
    launched.browserProcess.on('exit', () => { this.hasExited = true; });
    launched.browserProcess.on('close', () => { this.hasExited = true; });
  }

  async newPage(): Promise<PageDriver> {
    // Each page gets its own window: background tabs throttle animation frames and screenshots.
    const connection = this.launched.connection;
    const { targetId } = await connection.send<{ targetId: string }>(undefined, 'Target.createTarget', { url: 'about:blank', newWindow: true });
    const { sessionId } = await connection.send<{ sessionId: string }>(undefined, 'Target.attachToTarget', { targetId, flatten: true });
    const page = new ChromiumPage(connection, connection.session(sessionId), targetId);
    await page.initialise();
    return page;
  }

  exited(): boolean {
    const process = this.launched.browserProcess;
    return this.hasExited || process.exitCode !== null || process.signalCode !== null;
  }

  async close(): Promise<void> {
    await this.launched.stop();
  }
}

// Launches headless Chromium for scanning: no network outside 127.0.0.1.
export async function launchBrowser(executablePath: string): Promise<Browser> {
  const launched = await launchChromium(executablePath, { profilePrefix: 'accessibility-scan-' });
  const version = await launched.connection.send<{ product: string }>(undefined, 'Browser.getVersion');
  return new ChromiumBrowser(launched, version.product);
}
