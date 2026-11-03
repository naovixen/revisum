// The egress proxy: the one way out of a run. It lets a request through only to a declared origin
// or service, resolves the name itself, refuses it when any address the name resolves to is
// private, loopback, link-local or a metadata service (unless the service is declared private),
// and connects only to addresses it checked, each in turn, with no second lookup, so DNS rebinding
// cannot swap an address in between. Every decision is recorded. A name that doesn't resolve and an
// origin nobody listens on weren't refused, so they count as allowed and are noted as failures.
//
// Plain HTTP arrives as an absolute-form request and is forwarded; HTTPS and WebSockets arrive as
// CONNECT tunnels, of which the proxy sees only the host and port. On a declared fixture origin it
// can apply a browser mutant's rewrite to a plain-HTTP response body.
//
// For a database command it also relays plain TCP: one port per service the policy allows over
// TCP, the service's own declared port, to that service's address and nothing else. Each
// connection is vetted like a request (resolved by the proxy, metadata addresses refused) and
// recorded as a decision on "host:port".
// It runs in-process for tests and, in a run, in its own container (proxy-container.ts).
import type { AppliedRewrite, DeclaredService, EgressPolicy, ProxyDecision, ResponseRewrite } from '@revisum/contracts';
import { lookup } from 'node:dns/promises';
import type { EventEmitter } from 'node:events';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect as connectSocket, createServer as createTcpServer, isIP, type Server as TcpServer, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { checkResolvedAddress } from './address-check.ts';
import { hostAndPort, isPlainHttpOrigin } from './egress-events.ts';

// Resolves a host name to every address it has. Tests pass a fake that never touches the network.
export type AddressResolver = (hostname: string) => Promise<readonly string[]>;
// Opens a TCP connection to an address the proxy has checked.
export type AddressConnector = (address: string, port: number) => Socket;

export type RewriteRule = { readonly origin: string; readonly rewrite: ResponseRewrite };
// A TCP port the proxy relays: it listens on `port` and connects each client to `host` at the same
// port. `private` says the host may resolve to a private address, as for a service declared private.
export type TcpRelay = { readonly host: string; readonly port: number; readonly private: boolean };

// What the proxy enforces, as plain text, so the proxy container can read it from its settings.
export type ProxyRules = {
  // Every origin a request may reach: the policy's origins and its services' origins.
  readonly allowedOrigins: readonly string[];
  // The origins of services declared private, which may resolve to private addresses.
  readonly privateOrigins: readonly string[];
  readonly rewrites: readonly RewriteRule[];
  // Present only when the policy allows a service over TCP.
  readonly tcpRelays?: readonly TcpRelay[];
};

// Who sends requests through the proxy, which decides how it says no.
export const ProxyClient = { Service: 'service', Browser: 'browser' } as const;
export type ProxyClient = (typeof ProxyClient)[keyof typeof ProxyClient];

export type ProxyServerOptions = {
  // A service unless given.
  readonly client?: ProxyClient;
  readonly resolve?: AddressResolver;
  readonly connect?: AddressConnector;
  // Where the proxy listens: 127.0.0.1 on a free port unless given.
  readonly listenHost?: string;
  readonly port?: number;
  // Called with each decision as it is made, such as to write it where the runner can read it.
  readonly onDecision?: (decision: ProxyDecision) => void;
  // Called once per origin and mutant, the first time a rewrite changes a response.
  readonly onRewriteApplied?: (applied: AppliedRewrite) => void;
};

export type EgressProxyOptions = ProxyServerOptions & {
  readonly policy: EgressPolicy;
  // The project's declared services; only those the policy allows are reachable.
  readonly services?: readonly DeclaredService[];
};

// A declared origin the proxy allowed but could not connect to.
export type ConnectionFailure = { readonly origin: string; readonly message: string };

export type EgressProxy = {
  // The proxy's address, such as "http://127.0.0.1:41234", for --proxy-server or HTTP_PROXY.
  readonly url: string;
  // Every decision so far, in the order made.
  decisions(): readonly ProxyDecision[];
  // Each rewrite applied so far, once per origin and mutant.
  rewritesApplied(): readonly AppliedRewrite[];
  // Each origin it could not connect to so far, once per origin, with what to tell whoever is running.
  connectionFailures(): readonly ConnectionFailure[];
  close(): Promise<void>;
};

// How long one address may take to accept a connection, for every client.
const CONNECT_LIMIT_MILLISECONDS = 30_000;
// Above the service caller's longest call of 120 s, so the caller's own timeout decides. This limit
// only clears a connection nothing is waiting on.
const SERVICE_IDLE_LIMIT_MILLISECONDS = 130_000;
// The header on every answer the proxy writes itself, rather than passes on from a service, so a
// client such as runner's service caller can tell the proxy's refusal or failure from a status the
// service sent. The proxy strips it from every service response, so a service cannot forge it.
export const EGRESS_DECISION_HEADER = 'x-egress-decision';
// What the header says: the proxy refused the request, or could not get an answer from the service.
export type EgressDecisionMark = 'blocked' | 'unreachable';
// Headers that describe one connection, not the request, so they are never forwarded.
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const AUTHORITY = /^(\[[0-9a-fA-F:.%a-zA-Z]+\]|[^:[\]/\s]+):(\d{1,5})$/;
// How a decision names a request too malformed to name an origin. The reader of the proxy's file
// drops a decision with no origin, and the request's own text could hold anything, so neither is used.
const MALFORMED_REQUEST_ORIGIN = 'malformed-request';
// A client's parser passes on any three digits, such as 000, and Node's server throws on a status
// outside this range, which from inside a handler would end the proxy for every other request.
const isWritableStatus = (status: number): boolean => status >= 100 && status <= 999;
// These names are loopback by definition, so a lookup could only get that wrong. IPv4 goes first
// because most local apps bind it, and a refused connection can take seconds on Windows.
const LOOPBACK_ADDRESSES: readonly string[] = ['127.0.0.1', '::1'];

type ClientTreatment = {
  // How a plain request the proxy won't or can't carry through ends.
  readonly declineRequest: (response: ServerResponse, status: number, mark: EgressDecisionMark, text: string) => void;
  // How a tunnel the proxy won't or can't open ends.
  readonly declineTunnel: (client: Duplex, statusLine: string) => void;
  // How long a plain request's connection may sit with nothing moving. 0 is no limit.
  readonly idleLimitMilliseconds: number;
};

// A service reads the proxy's answer and acts on it. A browser would show it to the page as content:
// a page in a worker could read a 403, and a rendered 502 would pass for a page that loaded. A closed
// socket is a network error to a browser. A page may also hold a quiet connection open on purpose.
const TREATMENT_OF_CLIENT = {
  [ProxyClient.Service]: {
    declineRequest: answerFromProxy,
    declineTunnel: (client, statusLine) => { client.end(`HTTP/1.1 ${statusLine}\r\n\r\n`); },
    idleLimitMilliseconds: SERVICE_IDLE_LIMIT_MILLISECONDS,
  },
  [ProxyClient.Browser]: {
    declineRequest: (response) => { response.destroy(); },
    declineTunnel: (client) => { client.destroy(); },
    idleLimitMilliseconds: 0,
  },
} satisfies Record<ProxyClient, ClientTreatment>;

// The proxy's rules for a policy: its origins, the origins of the services it allows, which of
// those services are private, its rewrites, and a TCP relay for each service it allows over TCP
// that declares a port.
export function proxyRules(policy: EgressPolicy, services: readonly DeclaredService[] = []): ProxyRules {
  const allowedServices = services.filter((service) => policy.allowServices.includes(service.name));
  const tcpRelays = tcpRelaysFor(policy, services);
  return {
    allowedOrigins: [...new Set([...policy.allowOrigins, ...allowedServices.map((service) => service.origin)])],
    privateOrigins: allowedServices.filter((service) => service.private).map((service) => service.origin),
    rewrites: (policy.responseRewrites ?? []).map((entry) => ({ origin: entry.origin, rewrite: entry.rewrite })),
    ...(tcpRelays.length === 0 ? {} : { tcpRelays }),
  };
}

// The services a policy allows over TCP, each by the host its origin names and its declared port.
export function tcpRelaysFor(policy: EgressPolicy, services: readonly DeclaredService[]): readonly TcpRelay[] {
  return services.flatMap((service) => (policy.allowTcpServices.includes(service.name) && service.port !== undefined
    ? [{ host: withoutBrackets(new URL(service.origin).hostname), port: service.port, private: service.private }]
    : []));
}

// How a relay's decisions name what was reached: "host:port", an IPv6 host in brackets.
export const relayOrigin = (relay: TcpRelay): string => `${relay.host.includes(':') ? `[${relay.host}]` : relay.host}:${relay.port}`;

export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  return startProxyServer(proxyRules(options.policy, options.services), options);
}

const defaultResolver: AddressResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const defaultConnector: AddressConnector = (address, port) => connectSocket({ host: address, port });

const withoutBrackets = (hostname: string): string => hostname.replace(/^\[(.*)\]$/, '$1');

// Only the whole label counts, so "notlocalhost" and "app.localhost.attacker.test" are looked up.
function isLoopbackName(host: string): boolean {
  const name = host.toLowerCase();
  return name === 'localhost' || name.endsWith('.localhost');
}

const isLoopbackAddress = (address: string): boolean => address === '::1' || address.startsWith('127.');

// The proxy connects directly, on purpose, so a machine that reaches the network only through a proxy
// of its own can't connect out. Nothing the proxy sees tells that from a dead origin: a firewall can
// refuse, drop or fail a lookup just as a dead origin does, and a proxy setting in the environment
// says nothing about this connection. So the message names both. Loopback is the one certainty, since
// a connection to this machine never crosses a machine proxy.
function connectionFailureMessage(origin: string, addresses: readonly string[] | Error, failure: Error): string {
  const isOnThisMachine = !(addresses instanceof Error) && addresses.every(isLoopbackAddress);
  return isOnThisMachine
    ? `Nothing answered at ${origin} (${failure.message}).`
    : `Could not connect to ${origin} (${failure.message}). Either nothing answers there, or this machine reaches the network only through a proxy, and a machine proxy isn't supported yet.`;
}

// Aborts once the client's side has closed, so the proxy stops connecting on its behalf.
function abortedOnClose(clientSide: EventEmitter): AbortSignal {
  const controller = new AbortController();
  clientSide.once('close', () => { controller.abort(); });
  return controller.signal;
}

// The headers forwarded upstream: the client's, less the hop-by-hop ones, with the Host the URL names.
function forwardedHeaders(headers: IncomingHttpHeaders, host: string, rewriting: boolean): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (!HOP_BY_HOP_HEADERS.has(name) && value !== undefined) forwarded[name] = value;
  forwarded['host'] = host;
  forwarded['connection'] = 'close';
  // A body the proxy may rewrite has to arrive uncompressed.
  if (rewriting) forwarded['accept-encoding'] = 'identity';
  return forwarded;
}

// The headers passed back from a service: its own, less the hop-by-hop ones and the proxy's mark.
function answerHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const answered: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name) && name !== EGRESS_DECISION_HEADER && value !== undefined) answered[name] = value;
  }
  return answered;
}

// Writes an answer of the proxy's own, marked as such.
function answerFromProxy(response: ServerResponse, status: number, mark: EgressDecisionMark, text: string): void {
  response.writeHead(status, { 'content-type': 'text/plain', [EGRESS_DECISION_HEADER]: mark }).end(text);
}

export async function startProxyServer(rules: ProxyRules, options: ProxyServerOptions = {}): Promise<EgressProxy> {
  const treatment: ClientTreatment = TREATMENT_OF_CLIENT[options.client ?? ProxyClient.Service];
  const resolve = options.resolve ?? defaultResolver;
  const connect = options.connect ?? defaultConnector;
  const allowed = new Set(rules.allowedOrigins);
  const privateOrigins = new Set(rules.privateOrigins);
  const allowedHosts = new Set(rules.allowedOrigins.map(hostAndPort));
  const privateHosts = new Set(rules.privateOrigins.map(hostAndPort));
  // EgressPolicy is not branded, so a policy built by hand gets here without the builder's checks.
  const refusedRewrite = rules.rewrites.find((rule) => !allowed.has(rule.origin) || !isPlainHttpOrigin(rule.origin));
  if (refusedRewrite !== undefined) throw new Error(`a response rewrite may change only a declared plain-HTTP origin, not ${refusedRewrite.origin}`);
  const decided: ProxyDecision[] = [];
  const applied = new Map<string, AppliedRewrite>();
  const failures = new Map<string, ConnectionFailure>();
  const openSockets = new Set<Duplex>();

  const record = (origin: string, decision: ProxyDecision['decision']): void => {
    const entry: ProxyDecision = { origin, decision };
    decided.push(entry);
    options.onDecision?.(entry);
  };

  async function addressesOf(host: string): Promise<readonly string[] | Error> {
    if (isLoopbackName(host)) { return LOOPBACK_ADDRESSES; }
    if (isIP(host) !== 0) { return [host]; }
    try {
      return await resolve(host);
    } catch (error) {
      return error instanceof Error ? error : new Error(`the lookup of ${host} failed: ${String(error)}`);
    }
  }

  // The addresses to connect to, null when the request is refused, or an error when the name has none,
  // which isn't a refusal. An origin that is not declared is refused before its name is looked up, so
  // the lookup itself never leaves.
  async function vettedAddresses(hostname: string, declared: boolean, privateService: boolean): Promise<readonly string[] | Error | null> {
    if (!declared) { return null; }
    const host = withoutBrackets(hostname);
    const addresses = await addressesOf(host);
    if (addresses instanceof Error) { return addresses; }
    if (addresses.length === 0) { return new Error(`${host} resolved to no address`); }
    return addresses.some((address) => checkResolvedAddress(address, { privateService }) === 'refused') ? null : addresses;
  }

  function attemptConnection(address: string, port: number, abandoned: AbortSignal): Promise<Socket | Error> {
    if (abandoned.aborted) { return Promise.resolve(new Error('the client left before a connection opened')); }
    return new Promise((settleAttempt) => {
      const socket = connect(address, port);
      openSockets.add(socket);
      socket.once('close', () => openSockets.delete(socket));
      const onAbandoned = (): void => { socket.destroy(); };
      const onLimitReached = (): void => { socket.destroy(new Error(`${address} did not accept a connection in time`)); };
      const onClosedEarly = (): void => { settle(new Error(`the connection to ${address} closed before it opened`)); };
      const settle = (outcome: Socket | Error): void => {
        abandoned.removeEventListener('abort', onAbandoned);
        socket.setTimeout(0, onLimitReached);
        socket.off('error', settle);
        socket.off('close', onClosedEarly);
        settleAttempt(outcome);
      };
      abandoned.addEventListener('abort', onAbandoned, { once: true });
      socket.setTimeout(CONNECT_LIMIT_MILLISECONDS, onLimitReached);
      socket.once('error', settle);
      socket.once('close', onClosedEarly);
      socket.once('connect', () => { settle(socket); });
    });
  }

  // Tries each address until one accepts. Nothing has been sent by then, so moving on can't repeat a request.
  async function connectInTurn(addresses: readonly string[], port: number, abandoned: AbortSignal): Promise<Socket | Error> {
    let outcome: Socket | Error = new Error('there was no address to connect to');
    for (const address of addresses) {
      outcome = await attemptConnection(address, port, abandoned);
      if (!(outcome instanceof Error)) { return outcome; }
    }
    return outcome;
  }

  // A connection to one of the vetted addresses, or null when there is none to be had. Why is noted,
  // unless it is only that the client left.
  async function connectOut(seen: string, addresses: readonly string[] | Error, port: number, abandoned: AbortSignal): Promise<Socket | null> {
    const connection = addresses instanceof Error ? addresses : await connectInTurn(addresses, port, abandoned);
    if (!(connection instanceof Error)) { return connection; }
    if (!abandoned.aborted && !failures.has(seen)) {
      failures.set(seen, { origin: seen, message: connectionFailureMessage(seen, addresses, connection) });
    }
    return null;
  }

  async function forward(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const abandoned = abortedOnClose(response);
    const url = URL.parse(incoming.url ?? '');
    if (url === null) {
      record(MALFORMED_REQUEST_ORIGIN, 'blocked');
      treatment.declineRequest(response, 400, 'blocked', 'not a request the egress proxy forwards');
      return;
    }
    if (url.protocol !== 'http:') {
      // The URL parser writes "null" as the origin of a scheme it does not know.
      record(url.origin === 'null' ? MALFORMED_REQUEST_ORIGIN : url.origin, 'blocked');
      treatment.declineRequest(response, 400, 'blocked', 'not a request the egress proxy forwards');
      return;
    }
    const origin = url.origin;
    const addresses = await vettedAddresses(url.hostname, allowed.has(origin), privateOrigins.has(origin));
    if (addresses === null) {
      record(origin, 'blocked');
      treatment.declineRequest(response, 403, 'blocked', 'blocked by the egress proxy');
      return;
    }
    record(origin, 'allowed');
    const socket = await connectOut(origin, addresses, Number(url.port === '' ? 80 : url.port), abandoned);
    if (socket === null) {
      treatment.declineRequest(response, 502, 'unreachable', 'the service did not answer');
      return;
    }
    const rewrites = rules.rewrites.filter((rule) => rule.origin === origin);
    const upstream = request({
      method: incoming.method, path: `${url.pathname}${url.search}`, headers: forwardedHeaders(incoming.headers, url.host, rewrites.length > 0),
      createConnection: () => socket,
    });
    // A request's timeout option never reaches a socket from createConnection, so the limit goes on the socket.
    socket.setTimeout(treatment.idleLimitMilliseconds, () => { upstream.destroy(new Error('the upstream server did not answer')); });
    upstream.on('error', () => {
      if (response.destroyed) { return; }
      if (response.headersSent) {
        response.destroy();
      } else {
        treatment.declineRequest(response, 502, 'unreachable', 'the service did not answer');
      }
    });
    // A client that leaves early, such as one that stops reading at its size cap or gives up at its
    // timeout, ends the service's connection too, so the service stops sending.
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    upstream.on('response', (answer) => {
      if (!isWritableStatus(answer.statusCode ?? 502)) {
        treatment.declineRequest(response, 502, 'unreachable', 'the service sent a status HTTP does not have');
        upstream.destroy();
        return;
      }
      if (rewrites.length === 0) {
        response.writeHead(answer.statusCode ?? 502, answerHeaders(answer.headers));
        answer.pipe(response);
        return;
      }
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('end', () => {
        const body = rewriteBody(Buffer.concat(chunks), origin, rewrites);
        const headers = answerHeaders(answer.headers);
        headers['content-length'] = String(body.length);
        response.writeHead(answer.statusCode ?? 502, headers).end(body);
      });
    });
    incoming.pipe(upstream);
  }

  // Applies each rewrite whose text the body holds, and notes it as applied once per origin and name.
  // A body that holds none goes back byte for byte.
  function rewriteBody(body: Buffer, origin: string, rewrites: readonly RewriteRule[]): Buffer {
    const original = body.toString('utf8');
    let text = original;
    for (const { rewrite } of rewrites) {
      if (rewrite.find === '' || !text.includes(rewrite.find)) continue;
      text = text.split(rewrite.find).join(rewrite.replace);
      const key = `${origin}\n${rewrite.name}`;
      if (applied.has(key)) continue;
      const entry: AppliedRewrite = { origin, name: rewrite.name };
      applied.set(key, entry);
      options.onRewriteApplied?.(entry);
    }
    return text === original ? body : Buffer.from(text, 'utf8');
  }

  async function tunnel(incoming: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    openSockets.add(client);
    client.on('close', () => openSockets.delete(client));
    client.on('error', () => client.destroy());
    const abandoned = abortedOnClose(client);
    const authority = AUTHORITY.exec(incoming.url ?? '');
    const port = Number(authority?.[2] ?? 0);
    const hostname = URL.parse(`http://${authority?.[1] ?? ''}`)?.hostname ?? '';
    if (hostname === '' || port < 1 || port > 65_535) {
      record(hostname === '' ? MALFORMED_REQUEST_ORIGIN : `${hostname}:${port}`, 'blocked');
      treatment.declineTunnel(client, '400 Bad Request');
      return;
    }
    const seen = `${hostname}:${port}`;
    const addresses = await vettedAddresses(hostname, allowedHosts.has(seen), privateHosts.has(seen));
    if (addresses === null) {
      record(seen, 'blocked');
      treatment.declineTunnel(client, '403 Forbidden');
      return;
    }
    record(seen, 'allowed');
    const upstream = await connectOut(seen, addresses, port, abandoned);
    if (upstream === null) {
      treatment.declineTunnel(client, '502 Bad Gateway');
      return;
    }
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) { upstream.write(head); }
    upstream.pipe(client);
    client.pipe(upstream);
  }

  // A TCP relay: the client's bytes go, unread, to a vetted address of the relay's host.
  async function relay(client: Socket, target: TcpRelay): Promise<void> {
    openSockets.add(client);
    client.on('close', () => openSockets.delete(client));
    client.on('error', () => client.destroy());
    const abandoned = abortedOnClose(client);
    const seen = relayOrigin(target);
    const addresses = await vettedAddresses(target.host, true, target.private);
    if (addresses === null) {
      record(seen, 'blocked');
      client.destroy();
      return;
    }
    record(seen, 'allowed');
    const upstream = await connectOut(seen, addresses, target.port, abandoned);
    if (upstream === null) {
      client.destroy();
      return;
    }
    upstream.on('close', () => { client.destroy(); });
    upstream.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.pipe(client);
    client.pipe(upstream);
  }

  // Each relay listens before the proxy's own port does, so a proxy that answers relays too.
  const relayServers: TcpServer[] = [];
  const listenHost = options.listenHost ?? '127.0.0.1';
  try {
    for (const target of rules.tcpRelays ?? []) {
      const relayServer = createTcpServer((client) => { void relay(client, target); });
      relayServers.push(relayServer);
      await new Promise<void>((resolveListening, reject) => {
        relayServer.once('error', reject);
        relayServer.listen(target.port, listenHost, () => { relayServer.off('error', reject); resolveListening(); });
      });
    }
  } catch (error) {
    for (const relayServer of relayServers) relayServer.close();
    throw error;
  }

  const server = createServer((incoming, response) => { void forward(incoming, response); });
  server.on('connect', (incoming: IncomingMessage, client: Duplex, head: Buffer) => { void tunnel(incoming, client, head); });
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, listenHost, () => { server.off('error', reject); resolveListening(); });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${listenHost}:${port}`,
    decisions: () => [...decided],
    rewritesApplied: () => [...applied.values()],
    connectionFailures: () => [...failures.values()],
    close: () => new Promise<void>((resolveClosed) => {
      for (const socket of openSockets) socket.destroy();
      for (const relayServer of relayServers) relayServer.close();
      server.closeAllConnections();
      server.close(() => resolveClosed());
    }),
  };
}
