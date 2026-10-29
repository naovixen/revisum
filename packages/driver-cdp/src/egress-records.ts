// Records how each request of a session left the browser: an ordinary request of the page, a
// WebSocket, a worker's request, a popup's first load, a redirect or a beacon. The egress proxy
// outside the browser sees only hosts and ports over HTTPS, so these records give its decisions
// their channels. Only network schemes are recorded; data:, blob: and the like never leave.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import type { BrowserChannel, BrowserRequestRecord } from '@revisum/contracts';
import type { CdpConnection } from './cdp-connection.ts';

// Chrome DevTools Protocol event shapes this recorder reads.
type RequestWillBeSent = { readonly request: { readonly url: string }; readonly type?: string; readonly redirectResponse?: unknown };
type WebSocketCreated = { readonly url: string };
type AttachedToTarget = { readonly sessionId: string; readonly targetInfo: { readonly type: string }; readonly waitingForDebugger: boolean };

const NETWORK_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

export class EgressRecorder {
  readonly #connection: CdpConnection;
  readonly #records: BrowserRequestRecord[] = [];

  constructor(connection: CdpConnection) {
    this.#connection = connection;
  }

  records(): readonly BrowserRequestRecord[] {
    return [...this.#records];
  }

  // Notes a request by its URL, when its scheme reaches the network.
  record(url: string, channel: BrowserChannel): void {
    try {
      const parsed = new URL(url);
      if (NETWORK_SCHEMES.has(parsed.protocol)) this.#records.push({ origin: parsed.origin, channel });
    } catch {
      // A URL the browser could not have sent anywhere.
    }
  }

  // Watches one session's requests; `channel` is what an ordinary request of that session is.
  #watch(sessionId: string, channel: BrowserChannel): void {
    this.#connection.on(sessionId, 'Network.requestWillBeSent', (parameters) => {
      const sent = parameters as RequestWillBeSent;
      const kind: BrowserChannel = sent.redirectResponse !== undefined ? 'redirect' : sent.type === 'Ping' ? 'beacon' : channel;
      this.record(sent.request.url, kind);
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
