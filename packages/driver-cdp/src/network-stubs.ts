// The own driver's network port: declared stubs and request checks for the whole browser context,
// so they reach every tab of the session.
//   - A stub answers through CDP's Fetch domain, which already holds every request of a page for the
//     egress allow-list. Only fetch and XHR requests are answered; a document, script, style sheet,
//     frame, worker or image that matches goes on to the network as usual. Every answer is served
//     with its declared data media type and X-Content-Type-Options: nosniff, so the browser never
//     treats it as code. An answered request never leaves the browser, so the egress recorder is
//     told to leave it out of the session's egress records.
//   - A request check records the exchanges its matcher matches from CDP's Network domain. An
//     exchange counts once its response has arrived: a page need not read a body for it to count.
//     When the plan may read fields, the body is taken as the response is held at Fetch's response
//     stage, so it is there even when the page never reads it, and kept up to the declared cap.
//   - While any stub or check is active, the pages bypass their service workers, so every matching
//     request is seen and answered the same way, whatever a worker would have done with it.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import {
  failure, success,
  type DriverError, type NetworkPort, type ObservedExchange, type RequestMatcher, type RequestName, type ResolvedStub, type Result, type StubAnswer,
  type StubName,
} from '@revisum/contracts';
import type { CdpConnection } from './cdp-connection.ts';

// Chrome DevTools Protocol event shapes this port reads.
type RequestWillBeSent = {
  readonly requestId: string;
  readonly request: { readonly url: string; readonly method: string };
  readonly redirectResponse?: { readonly status: number; readonly mimeType?: string };
};
type ResponseReceived = { readonly requestId: string; readonly response: { readonly status: number; readonly mimeType?: string } };
type LoadingFailed = { readonly requestId: string };
// What the Fetch domain says of a request it holds, before it is sent or once its response is in.
export type HeldRequest = {
  readonly resourceType?: string;
  readonly request: { readonly url: string; readonly method: string };
  // The Network domain's id for the same request, when that domain sees it.
  readonly networkId?: string;
  // Present only at the response stage.
  readonly responseStatusCode?: number;
  readonly responseErrorReason?: string;
};
// What a stub answers a held request with, as Fetch.fulfillRequest takes it.
export type StubbedResponse = {
  readonly responseCode: number;
  readonly responseHeaders: readonly { readonly name: string; readonly value: string }[];
  readonly body: string;
};

// The only resource types a stub may answer: data a page script asked for.
const STUBBED_RESOURCE_TYPES = ['Fetch', 'XHR'];
const POLL_INTERVAL_MILLISECONDS = 25;

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

// True when the request is one the matcher names: the same origin and method, and the same path,
// exactly or as a prefix, without the query.
export function matchesRequest(matcher: RequestMatcher, method: string, url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.origin !== matcher.origin || method.toUpperCase() !== matcher.method) return false;
  return matcher.match === 'exact' ? parsed.pathname === matcher.path : parsed.pathname.startsWith(matcher.path);
}

// True when the Fetch domain holds the request at its response stage, with the response in.
export const atResponseStage = (held: HeldRequest): boolean => held.responseStatusCode !== undefined || held.responseErrorReason !== undefined;

type ActiveStub = {
  readonly stub: ResolvedStub;
  // Each response's body, its fixture already read.
  readonly bodies: readonly Uint8Array[];
  served: number;
};

// One observed request's record. A reset starts a new generation, so an exchange that began before
// it is never counted after it.
type Observation = {
  readonly matcher: RequestMatcher;
  readonly maximumResponseBytes: number | null;
  generation: number;
  finished: ObservedExchange[];
  // The requests in flight, by page session and request id.
  readonly inFlight: Set<string>;
  // When a matching request last started or finished.
  lastActivity: number;
};

// A matching request still in flight, and the observations that wait for it.
type PendingExchange = {
  readonly sessionId: string;
  readonly requestId: string;
  readonly url: string;
  readonly observers: readonly { readonly observation: Observation; readonly generation: number }[];
};

export type BrowserNetworkOptions = {
  // The bytes of a declared fixture from the project's fixtures folder, never from outside it.
  readonly readFixture: (fixture: string) => Result<Uint8Array, DriverError>;
  // Told the Network domain's id of each request a stub answered inside the browser.
  readonly onAnsweredInBrowser: (networkRequestId: string) => void;
};

export class BrowserNetwork implements NetworkPort {
  readonly #connection: CdpConnection;
  readonly #options: BrowserNetworkOptions;
  // Page sessions, each with what stops listening to it.
  readonly #pages = new Map<string, () => void>();
  // In the order they were started.
  readonly #stubs = new Map<StubName, ActiveStub>();
  readonly #answers: StubAnswer[] = [];
  // What each stub answered, by the Network domain's request id.
  readonly #answered = new Map<string, { readonly stub: StubName; readonly body: Uint8Array }>();
  // Bodies taken at the response stage, by the Network domain's request id, until the exchange ends.
  readonly #takenBodies = new Map<string, Uint8Array>();
  readonly #observations = new Map<RequestName, Observation>();
  readonly #pending = new Map<string, PendingExchange>();
  #bypassingWorkers = false;

  constructor(connection: CdpConnection, options: BrowserNetworkOptions) {
    this.#connection = connection;
    this.#options = options;
  }

  // Starts watching a page session's requests; its Network domain is already enabled. Gives what
  // stops watching it, for a tab that closes.
  async watchPage(sessionId: string): Promise<() => void> {
    const connection = this.#connection;
    const stops = [
      connection.on(sessionId, 'Network.requestWillBeSent', (parameters) => this.#requestSent(sessionId, parameters as RequestWillBeSent)),
      connection.on(sessionId, 'Network.responseReceived', (parameters) => {
        const received = parameters as ResponseReceived;
        const pending = this.#pending.get(pendingKey(sessionId, received.requestId));
        if (pending !== undefined) this.#finish(pending, received.response.status, received.response.mimeType ?? null);
      }),
      connection.on(sessionId, 'Network.loadingFailed', (parameters) => {
        const pending = this.#pending.get(pendingKey(sessionId, (parameters as LoadingFailed).requestId));
        if (pending !== undefined) this.#finish(pending, null, null);
      }),
    ];
    const stop = (): void => { for (const stopListening of stops) stopListening(); this.#pages.delete(sessionId); };
    this.#pages.set(sessionId, stop);
    if (this.#bypassingWorkers) await this.#connection.send(sessionId, 'Network.setBypassServiceWorker', { bypass: true });
    return stop;
  }

  // ---- Stubs ----

  async startStub(stub: ResolvedStub): Promise<Result<void, DriverError>> {
    const bodies: Uint8Array[] = [];
    for (const response of stub.responses) {
      if (response.body instanceof Uint8Array) { bodies.push(response.body); continue; }
      const read = this.#options.readFixture(response.body.fixture);
      if (!read.ok) return read;
      bodies.push(read.value);
    }
    // Started again, a stub moves to the end of the order and starts from its first response.
    this.#stubs.delete(stub.name);
    this.#stubs.set(stub.name, { stub, bodies, served: 0 });
    return this.#bypassWhileActive();
  }

  async stopStub(name: StubName): Promise<Result<void, DriverError>> {
    this.#stubs.delete(name);
    return this.#bypassWhileActive();
  }

  stubAnswers(): readonly StubAnswer[] {
    return [...this.#answers];
  }

  // The answer for a request the Fetch domain holds, or null when no active stub answers it. The
  // stub started last wins when several match. Called only for requests the allow-list let
  // through: a stub answers, it never lets a request through that was refused.
  answer(held: HeldRequest): StubbedResponse | null {
    if (held.resourceType === undefined || !STUBBED_RESOURCE_TYPES.includes(held.resourceType)) return null;
    const active = [...this.#stubs.values()].reverse().find((candidate) => matchesRequest(candidate.stub.request, held.request.method, held.request.url));
    if (active === undefined) return null;
    // The last response repeats.
    const index = Math.min(active.served, active.stub.responses.length - 1);
    active.served += 1;
    const response = active.stub.responses[index];
    const body = active.bodies[index];
    if (response === undefined || body === undefined) return null;
    this.#answers.push({ stub: active.stub.name, responseIndex: index + 1 });
    if (held.networkId !== undefined) {
      this.#answered.set(held.networkId, { stub: active.stub.name, body });
      this.#options.onAnsweredInBrowser(held.networkId);
    }
    return {
      responseCode: response.status,
      responseHeaders: [
        { name: 'content-type', value: response.mediaType },
        { name: 'x-content-type-options', value: 'nosniff' },
        ...response.headers.map(([name, value]) => ({ name, value })),
      ],
      body: Buffer.from(body).toString('base64'),
    };
  }

  // ---- Request checks ----

  async observe(name: RequestName, matcher: RequestMatcher, maximumResponseBytes: number | null): Promise<Result<void, DriverError>> {
    const observation = this.#observations.get(name);
    if (observation === undefined) {
      this.#observations.set(name, { matcher, maximumResponseBytes, generation: 0, finished: [], inFlight: new Set(), lastActivity: Date.now() });
      return this.#bypassWhileActive();
    }
    // A reset: what came before is forgotten, and a request still in flight is never counted.
    observation.generation += 1;
    observation.finished = [];
    observation.inFlight.clear();
    observation.lastActivity = Date.now();
    return success(undefined);
  }

  exchanges(name: RequestName): readonly ObservedExchange[] {
    return [...(this.#observations.get(name)?.finished ?? [])];
  }

  async quiet(name: RequestName, quietMilliseconds: number, timeoutMilliseconds: number): Promise<Result<void, DriverError>> {
    const observation = this.#observations.get(name);
    if (observation === undefined) return failure({ code: 'unsupported-step', detail: 'the request is not observed' });
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMilliseconds;
    for (;;) {
      const now = Date.now();
      if (observation.inFlight.size === 0 && now - Math.max(observation.lastActivity, startedAt) >= quietMilliseconds) return success(undefined);
      if (now >= deadline) return failure({ code: 'timeout', detail: `a matching request was still in flight after ${timeoutMilliseconds} ms` });
      await pause(POLL_INTERVAL_MILLISECONDS);
    }
  }

  // True when a request check whose fields a plan may read matches the held request, so its
  // response is held too and its body taken before the page gets it.
  wantsResponseBody(held: HeldRequest): boolean {
    return [...this.#observations.values()].some((observation) =>
      observation.maximumResponseBytes !== null && matchesRequest(observation.matcher, held.request.method, held.request.url));
  }

  // Keeps the body taken at the response stage for the exchange's record.
  keepResponseBody(networkRequestId: string, body: Uint8Array): void {
    this.#takenBodies.set(networkRequestId, body);
  }

  #requestSent(sessionId: string, sent: RequestWillBeSent): void {
    const key = pendingKey(sessionId, sent.requestId);
    // A redirect reuses the request's id: the exchange before it ends with the redirect's status.
    const redirected = this.#pending.get(key);
    if (redirected !== undefined && sent.redirectResponse !== undefined) {
      this.#finish(redirected, sent.redirectResponse.status, sent.redirectResponse.mimeType ?? null);
    }
    const now = Date.now();
    const observers = [...this.#observations.values()]
      .filter((observation) => matchesRequest(observation.matcher, sent.request.method, sent.request.url))
      .map((observation) => ({ observation, generation: observation.generation }));
    if (observers.length === 0) return;
    for (const { observation } of observers) {
      observation.inFlight.add(key);
      observation.lastActivity = now;
    }
    this.#pending.set(key, { sessionId, requestId: sent.requestId, url: sent.request.url, observers });
  }

  // The exchange ends once its response has arrived, or the request failed (status null). Its body
  // is a stub's answer, or what was taken at the response stage; the page need not read it.
  #finish(pending: PendingExchange, status: number | null, mediaType: string | null): void {
    const key = pendingKey(pending.sessionId, pending.requestId);
    if (this.#pending.get(key) !== pending) return;
    this.#pending.delete(key);
    const answered = this.#answered.get(pending.requestId);
    const body = answered?.body ?? this.#takenBodies.get(pending.requestId) ?? null;
    this.#takenBodies.delete(pending.requestId);
    const now = Date.now();
    for (const { observation, generation } of pending.observers) {
      // Reset since the request began: it is not counted.
      if (observation.generation !== generation) continue;
      observation.inFlight.delete(key);
      observation.lastActivity = now;
      const cap = observation.maximumResponseBytes;
      observation.finished.push({
        method: observation.matcher.method, url: pending.url, status, mediaType,
        // A body over the cap is kept to one byte past it, so a reader can tell it was too large.
        body: cap === null || body === null ? null : body.subarray(0, cap + 1),
        stubbed: answered?.stub ?? null,
      });
    }
  }

  // Service workers are bypassed while any stub or request check is active, and only then.
  async #bypassWhileActive(): Promise<Result<void, DriverError>> {
    const wanted = this.#stubs.size > 0 || this.#observations.size > 0;
    if (wanted === this.#bypassingWorkers) return success(undefined);
    this.#bypassingWorkers = wanted;
    try {
      for (const sessionId of this.#pages.keys()) await this.#connection.send(sessionId, 'Network.setBypassServiceWorker', { bypass: wanted });
      return success(undefined);
    } catch (error) {
      return failure({ code: 'not-actionable', detail: `service workers could not be bypassed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) });
    }
  }
}

const pendingKey = (sessionId: string, requestId: string): string => `${sessionId} ${requestId}`;
