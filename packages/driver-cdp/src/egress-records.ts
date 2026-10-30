// Records how each request of a session left the browser: an ordinary request of the page, a
// WebSocket, a worker's request, a popup's first load, a redirect or a beacon. The egress proxy
// outside the browser sees only hosts and ports over HTTPS, so these records give its decisions
// their channels. Only network schemes are recorded; data:, blob: and the like never leave, and
// neither does a request a declared stub answered inside the browser, so it is left out.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import type { BrowserChannel, BrowserRequestRecord } from '@revisum/contracts';
import type { CdpConnection } from './cdp-connection.ts';

// Chrome DevTools Protocol event shapes this recorder reads.
type RequestWillBeSent = {
  readonly requestId: string; readonly request: { readonly url: string }; readonly type?: string; readonly redirectResponse?: unknown;
};
type WebSocketCreated = { readonly url: string };
type AttachedToTarget = { readonly sessionId: string; readonly targetInfo: { readonly type: string }; readonly waitingForDebugger: boolean };

const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

export class EgressRecorder {
  readonly #connection: CdpConnection;
  // Each record with the Network domain's id of its request, when it has one.
  readonly #records: { readonly record: BrowserRequestRecord; readonly requestId: string | null }[] = [];
  // The ids of the requests a stub answered inside the browser.
  readonly #answeredInBrowser = new Set<string>();

  constructor(connection: CdpConnection) {
    this.#connection = connection;
  }

  records(): readonly BrowserRequestRecord[] {
    return this.#records.filter((kept) => kept.requestId === null || !this.#answeredInBrowser.has(kept.requestId)).map((kept) => kept.record);
  }

  // Leaves the request out of the records: a stub answered it, so it never left the browser. The
  // stub may answer before or after the request is recorded, so it is left out as records are read.
  answeredInBrowser(requestId: string): void {
    this.#answeredInBrowser.add(requestId);
  }

  // Notes a request by its URL, when its scheme reaches the network.
  record(url: string, channel: BrowserChannel, requestId: string | null = null): void {
    try {
      const parsed = new URL(url);
      if (NETWORK_SCHEMES.has(parsed.protocol)) this.#records.push({ record: { origin: parsed.origin, channel }, requestId });
    } catch {
      // A URL the browser could not have sent anywhere.
    }
  }

  // Watches one session's requests; `channel` is what an ordinary request of that session is.
  #watch(sessionId: string, channel: BrowserChannel): void {
    this.#connection.on(sessionId, 'Network.requestWillBeSent', (parameters) => {
      const sent = parameters as RequestWillBeSent;
      const kind: BrowserChannel = sent.redirectResponse !== undefined ? 'redirect' : sent.type === 'Ping' ? 'beacon' : channel;
      this.record(sent.request.url, kind, sent.requestId);
    });
    this.#connection.on(sessionId, 'Network.webSocketCreated', (parameters) => this.record((parameters as WebSocketCreated).url, 'websocket'));
  }

  // Starts recording the page's requests and its dedicated workers'. A worker is attached paused,
  // so its first request is not missed, and let run once its requests are watched.
  async start(pageSessionId: string): Promise<void> {
    const connection = this.#connection;
    this.#watch(pageSessionId, 'page');
    connection.on(pageSessionId, 'Target.attachedToTarget', (parameters) => {
      const attached = parameters as AttachedToTarget;
      if (attached.targetInfo.type === 'worker') this.#watch(attached.sessionId, 'worker');
      const watching = attached.targetInfo.type === 'worker' ? connection.send(attached.sessionId, 'Network.enable') : Promise.resolve();
      void watching.catch(() => undefined)
        .then(() => (attached.waitingForDebugger ? connection.send(attached.sessionId, 'Runtime.runIfWaitingForDebugger') : undefined))
        .catch(() => undefined);
    });
    await connection.send(pageSessionId, 'Network.enable');
    await connection.send(pageSessionId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'worker' }] });
  }
}
