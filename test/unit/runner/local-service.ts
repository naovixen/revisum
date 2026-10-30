// Shared setup for the tests of runner's real service caller, which sends a declared call's
// request through the egress proxy:
//
//   - startLocalService() is a node:http server on loopback. It records every request it
//     receives, in order, with its method, path, headers and body, then answers as the test says.
//     Its connect function lets the proxy reach it whatever address the proxy vetted;
//   - withCallerHarness() puts the egress proxy in front of it, with the services the test
//     declares and a fake resolver that never touches the network, and builds the real caller;
//   - serviceRequest() builds the request the engine would hand the caller;
//   - consoleWrittenDuring() copies what the process writes to stdout and stderr, so a test can
//     show the caller logs no header value.
//
// What these tests assume about the caller's shape, gathered here so a change to it is a change
// to this file only (docs/specs/SPEC-32-declared-service-calls.md, "The real caller"):
//   - runner exports serviceCaller({ proxy }), where `proxy` is the running EgressProxy, and every
//     request goes to proxy.url;
//   - it answers with the Result the ServiceCaller port declares: a ServiceResponse whose status
//     and body are exactly what the service sent, or one ServiceCallErrorCode.
// See docs/specs/SPEC-32-declared-service-calls.md and docs/specs/SPEC-07-isolated-runner-and-egress.md.
import { createServer, type IncomingHttpHeaders, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect, type Socket } from 'node:net';
import type { DeclaredService, HttpMethod, Secret, ServiceCaller, ServiceRequest, ServiceRequestHeader } from '@revisum/contracts';
import { serviceCaller, startEgressProxy, type EgressProxy } from '@revisum/runner';
import { declaredService, egressPolicy, fakeResolver, origin, type FakeResolver } from './runner-examples.ts';

// ---- The local service ---------------------------------------------------------------------------

export type ReceivedRequest = { readonly method: string; readonly path: string; readonly headers: IncomingHttpHeaders; readonly body: string };

// Answers one request. `earlier` holds every request received before this one. An answer that
// writes nothing stands for a service that never answers.
export type Answer = (received: ReceivedRequest, response: ServerResponse, earlier: readonly ReceivedRequest[]) => void;

export type Dialled = { readonly address: string; readonly port: number };

export type LocalService = {
  // http://127.0.0.1:<port>, where the service listens.
  readonly origin: string;
  readonly port: number;
  // Every request the service received, in order, recorded once its body has arrived.
  readonly received: readonly ReceivedRequest[];
  // Every address and port the proxy asked for, when the proxy's connections are routed here.
  readonly dialled: readonly Dialled[];
  // A connect function for the proxy: it records the vetted address and port, then connects to
  // this service instead, so nothing leaves the machine.
  connect(address: string, port: number): Socket;
  // Changes how the service answers from now on.
  answerWith(answer: Answer): void;
  close(): Promise<void>;
};

export const OK_BODY = { status: 'paid', total: 42 };

export const jsonAnswer = (status: number, body: unknown): Answer => (received, response) => {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

export const textAnswer = (status: number, mediaType: string, text: string): Answer => (received, response) => {
  response.writeHead(status, { 'content-type': mediaType }).end(text);
};

export const emptyAnswer = (status: number, headers: OutgoingHttpHeaders = {}): Answer => (received, response) => {
  response.writeHead(status, headers).end();
};

// Never answers: the request is read and left open.
export const silentAnswer: Answer = () => undefined;

// Sends its status and headers, then never finishes the body.
export const unfinishedAnswer: Answer = (received, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.write('{"status":');
};

// Drops the connection once the request has arrived, without answering.
export const droppedAnswer: Answer = (received, response) => {
  response.socket?.destroy();
};

// `length` bytes of JSON-safe text, with a content-length header, or chunked when `chunked` is set.
export const sizedAnswer = (length: number, chunked = false): Answer => (received, response) => {
  const body = Buffer.alloc(length, 'a');
  response.writeHead(200, chunked ? { 'content-type': 'text/plain' } : { 'content-type': 'text/plain', 'content-length': String(length) });
  if (!chunked) {
    response.end(body);
    return;
  }
  // Two writes, so the body really arrives in more than one chunk.
  const half = Math.floor(length / 2);
  response.write(body.subarray(0, half));
  response.end(body.subarray(half));
};

export type EndlessAnswer = { readonly answer: Answer; sentBytes(): number };

// Streams up to `totalBytes`, chunked, writing only as fast as the reader takes it, and stops when
// the connection closes. sentBytes() is how much it managed to hand to the connection.
export function endlessAnswer(totalBytes: number): EndlessAnswer {
  const chunk = Buffer.alloc(64 * 1024, 'a');
  let sent = 0;
  const answer: Answer = (received, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    let closed = false;
    response.on('close', () => { closed = true; });
    const writeMore = (): void => {
      while (!closed && sent < totalBytes) {
        sent += chunk.length;
        if (!response.write(chunk)) {
          response.once('drain', writeMore);
          return;
        }
      }
      if (!closed) response.end();
    };
    writeMore();
  };
  return { answer, sentBytes: () => sent };
}

export async function startLocalService(answer: Answer = jsonAnswer(200, OK_BODY)): Promise<LocalService> {
  const received: ReceivedRequest[] = [];
  const dialled: Dialled[] = [];
  let current = answer;
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request: ReceivedRequest = {
        method: incoming.method ?? '', path: incoming.url ?? '', headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8'),
      };
      const earlier = [...received];
      received.push(request);
      current(request, response, earlier);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`, port, received, dialled,
    connect(address, requestedPort) {
      dialled.push({ address, port: requestedPort });
      return connect(port, '127.0.0.1');
    },
    answerWith(next) { current = next; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// A loopback port with nothing listening on it: a server is opened there, then closed.
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ---- The caller -----------------------------------------------------------------------------------

// Runner's real caller, sending every request through `proxy`. The only place the caller is built.
export const realCaller = (proxy: EgressProxy): ServiceCaller => serviceCaller({ proxy });

// The name the local service itself is declared under.
export const LOCAL_SERVICE_NAME = 'local-shop';

export type HarnessOptions = {
  // How the local service answers; 200 with a small JSON body unless given.
  readonly answer?: Answer;
  // What the fake resolver answers for each name. A name it does not know fails to resolve.
  readonly names?: Readonly<Record<string, readonly string[]>>;
  // Services declared besides the local service itself.
  readonly services?: readonly DeclaredService[];
  // Whether the local service, on its loopback origin, is declared private. True unless given.
  readonly localServicePrivate?: boolean;
  // True lets the proxy connect to the address it vetted for real. Otherwise every connection the
  // proxy makes goes to the local service, whatever address it vetted.
  readonly realConnections?: boolean;
};

export type CallerHarness = {
  readonly service: LocalService;
  readonly proxy: EgressProxy;
  readonly caller: ServiceCaller;
  readonly resolver: FakeResolver;
};

export async function withCallerHarness(options: HarnessOptions, body: (harness: CallerHarness) => Promise<void>): Promise<void> {
  const service = await startLocalService(options.answer);
  const services = [declaredService(LOCAL_SERVICE_NAME, service.origin, options.localServicePrivate ?? true), ...(options.services ?? [])];
  const resolver = fakeResolver(options.names ?? {});
  const proxy = await startEgressProxy({
    policy: egressPolicy({ allowServices: services.map((declared) => declared.name) }),
    services,
    resolve: resolver.resolve,
    ...(options.realConnections === true ? {} : { connect: (address: string, port: number) => service.connect(address, port) }),
  });
  try {
    await body({ service, proxy, caller: realCaller(proxy), resolver });
  } finally {
    await proxy.close();
    await service.close();
  }
}

// ---- Requests ---------------------------------------------------------------------------------------

export const ORDER_PATH = '/api/orders/ord_1042';

export type RequestChanges = {
  readonly method?: HttpMethod;
  readonly pathAndQuery?: string;
  readonly headers?: readonly ServiceRequestHeader[];
  // The body's JSON parts; null for no body.
  readonly body?: readonly (string | Secret)[] | null;
  readonly timeoutMilliseconds?: number;
  readonly maximumResponseBytes?: number;
};

// The request the engine would build for a call to `target`: GET ORDER_PATH with no headers and no
// body, a 5 s timeout and a 1 MiB cap, unless `changes` says otherwise.
export function serviceRequest(target: string, changes: RequestChanges = {}): ServiceRequest {
  const parts = changes.body === undefined ? null : changes.body;
  return {
    origin: origin(target),
    method: changes.method ?? 'GET',
    pathAndQuery: changes.pathAndQuery ?? ORDER_PATH,
    headers: changes.headers ?? [],
    body: parts === null ? null : { jsonParts: parts },
    timeoutMilliseconds: changes.timeoutMilliseconds ?? 5000,
    maximumResponseBytes: changes.maximumResponseBytes ?? 1024 * 1024,
  };
}

// The response body as text, to compare with what the service sent.
export const bodyAsText = (body: Uint8Array): string => Buffer.from(body).toString('utf8');

// Waits a little longer, so a request the caller wrongly sends again has time to arrive.
export const settle = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

// ---- The console ------------------------------------------------------------------------------------

// Runs `during` while copying everything the process writes to stdout and stderr, which is where
// console output goes, and gives back the copied text. The writes still reach the streams.
export async function consoleWrittenDuring(during: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const copy = (stream: NodeJS.WriteStream): (() => void) => {
    const original = stream.write;
    const copying = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk instanceof Uint8Array ? chunk : new Uint8Array()).toString('utf8'));
      return Boolean(Reflect.apply(original, this, [chunk, ...rest]));
    };
    stream.write = copying as typeof stream.write;
    return () => { stream.write = original; };
  };
  const restoreOut = copy(process.stdout);
  const restoreError = copy(process.stderr);
  try {
    await during();
  } finally {
    restoreOut();
    restoreError();
  }
  return written.join('');
}
