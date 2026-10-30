// The egress proxy: the one way out of a run. It lets a request through only to a declared origin
// or service, resolves the name itself, refuses it when any address the name resolves to is
// private, loopback, link-local or a metadata service (unless the service is declared private),
// and connects to the very address it checked, with no second lookup, so DNS rebinding cannot
// swap the address in between. Every decision is recorded.
//
// Plain HTTP arrives as an absolute-form request and is forwarded; HTTPS and WebSockets arrive as
// CONNECT tunnels, of which the proxy sees only the host and port. On a declared fixture origin it
// can apply a browser mutant's rewrite to a plain-HTTP response body.
// It runs in-process for tests and, in a run, in its own container (proxy-container.ts).
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import type { AppliedRewrite, DeclaredService, EgressPolicy, ProxyDecision, ResponseRewrite } from '@revisum/contracts';
import { lookup } from 'node:dns/promises';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect as connectSocket, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { checkResolvedAddress } from './address-check.ts';
import { hostAndPort } from './egress-events.ts';

// Resolves a host name to every address it has. Tests pass a fake that never touches the network.
export type AddressResolver = (hostname: string) => Promise<readonly string[]>;
// Opens a TCP connection to an address the proxy has checked.
export type AddressConnector = (address: string, port: number) => Socket;

export type RewriteRule = { readonly origin: string; readonly rewrite: ResponseRewrite };

// What the proxy enforces, as plain text, so the proxy container can read it from its settings.
export type ProxyRules = {
  // Every origin a request may reach: the policy's origins and its services' origins.
  readonly allowedOrigins: readonly string[];
  // The origins of services declared private, which may resolve to private addresses.
  readonly privateOrigins: readonly string[];
  readonly rewrites: readonly RewriteRule[];
};

export type ProxyServerOptions = {
  readonly resolve?: AddressResolver;
  readonly connect?: AddressConnector;
  // Where the proxy listens: 127.0.0.1 on a free port unless given.
  readonly listenHost?: string;
  readonly port?: number;
  // Called with each decision as it is made, such as to write it where the runner can read it.
  readonly onDecision?: (decision: ProxyDecision) => void;
};

export type EgressProxyOptions = ProxyServerOptions & {
  readonly policy: EgressPolicy;
  // The project's declared services; only those the policy allows are reachable.
  readonly services?: readonly DeclaredService[];
};

export type EgressProxy = {
  // The proxy's address, such as "http://127.0.0.1:41234", for --proxy-server or HTTP_PROXY.
  readonly url: string;
  // Every decision so far, in the order made.
  decisions(): readonly ProxyDecision[];
  // Each rewrite applied so far, once per origin and mutant.
  rewritesApplied(): readonly AppliedRewrite[];
  close(): Promise<void>;
};

const UPSTREAM_TIMEOUT_MILLISECONDS = 30_000;
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

// The proxy's rules for a policy: its origins, the origins of the services it allows, which of
// those services are private, and its rewrites.
export function proxyRules(policy: EgressPolicy, services: readonly DeclaredService[] = []): ProxyRules {
  const allowedServices = services.filter((service) => policy.allowServices.includes(service.name));
  return {
    allowedOrigins: [...new Set([...policy.allowOrigins, ...allowedServices.map((service) => service.origin)])],
    privateOrigins: allowedServices.filter((service) => service.private).map((service) => service.origin),
    rewrites: (policy.responseRewrites ?? []).map((entry) => ({ origin: entry.origin, rewrite: entry.rewrite })),
  };
}

export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  return startProxyServer(proxyRules(options.policy, options.services), options);
}

const defaultResolver: AddressResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const defaultConnector: AddressConnector = (address, port) => connectSocket({ host: address, port });

const withoutBrackets = (hostname: string): string => hostname.replace(/^\[(.*)\]$/, '$1');

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
  const resolve = options.resolve ?? defaultResolver;
  const connect = options.connect ?? defaultConnector;
  const allowed = new Set(rules.allowedOrigins);
  const privateOrigins = new Set(rules.privateOrigins);
  const allowedHosts = new Set(rules.allowedOrigins.map(hostAndPort));
  const privateHosts = new Set(rules.privateOrigins.map(hostAndPort));
  const decided: ProxyDecision[] = [];
  const applied = new Map<string, AppliedRewrite>();
  const openSockets = new Set<Duplex>();

  const record = (origin: string, decision: ProxyDecision['decision']): void => {
    const entry: ProxyDecision = { origin, decision };
    decided.push(entry);
    options.onDecision?.(entry);
  };

  // The address to connect to, or null when the request is refused: an origin that is not
  // declared is refused before its name is looked up, so the lookup itself never leaves.
  async function vettedAddress(hostname: string, declared: boolean, privateService: boolean): Promise<string | null> {
    if (!declared) return null;
    const host = withoutBrackets(hostname);
    let addresses: readonly string[];
    try {
      addresses = isIP(host) === 0 ? await resolve(host) : [host];
    } catch {
      return null;
    }
    if (addresses.length === 0 || addresses.some((address) => checkResolvedAddress(address, { privateService }) === 'refused')) return null;
    return addresses[0] ?? null;
  }

  async function forward(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(incoming.url ?? '');
    } catch {
      answerFromProxy(response, 400, 'blocked', 'not a request the egress proxy forwards');
      return;
    }
    if (url.protocol !== 'http:') {
      answerFromProxy(response, 400, 'blocked', 'not a request the egress proxy forwards');
      return;
    }
    const origin = url.origin;
    const address = await vettedAddress(url.hostname, allowed.has(origin), privateOrigins.has(origin));
    if (address === null) {
      record(origin, 'blocked');
      answerFromProxy(response, 403, 'blocked', 'blocked by the egress proxy');
      return;
    }
    record(origin, 'allowed');
    const rewrites = rules.rewrites.filter((rule) => rule.origin === origin);
    const socket = connect(address, Number(url.port === '' ? 80 : url.port));
    const upstream = request({
      method: incoming.method, path: `${url.pathname}${url.search}`, headers: forwardedHeaders(incoming.headers, url.host, rewrites.length > 0),
      createConnection: () => socket, timeout: UPSTREAM_TIMEOUT_MILLISECONDS,
    });
    upstream.on('timeout', () => upstream.destroy(new Error('the upstream server did not answer')));
    upstream.on('error', () => {
      if (response.destroyed) return;
      if (!response.headersSent) answerFromProxy(response, 502, 'unreachable', 'the service did not answer');
      else response.destroy();
    });
    // A client that leaves early, such as one that stops reading at its size cap or gives up at its
    // timeout, ends the service's connection too, so the service stops sending.
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    upstream.on('response', (answer) => {
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
      if (!applied.has(key)) applied.set(key, { origin, name: rewrite.name });
    }
    return text === original ? body : Buffer.from(text, 'utf8');
  }

  async function tunnel(incoming: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    openSockets.add(client);
    client.on('close', () => openSockets.delete(client));
    client.on('error', () => client.destroy());
    const authority = AUTHORITY.exec(incoming.url ?? '');
    const port = Number(authority?.[2] ?? 0);
    let hostname: string;
    try {
      hostname = new URL(`http://${authority?.[1] ?? ''}`).hostname;
    } catch {
      hostname = '';
    }
    if (hostname === '' || port < 1 || port > 65_535) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const seen = `${hostname}:${port}`;
    const address = await vettedAddress(hostname, allowedHosts.has(seen), privateHosts.has(seen));
    if (address === null) {
      record(seen, 'blocked');
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    record(seen, 'allowed');
    const upstream = connect(address, port);
    openSockets.add(upstream);
    upstream.on('close', () => openSockets.delete(upstream));
    let established = false;
    upstream.setTimeout(UPSTREAM_TIMEOUT_MILLISECONDS, () => upstream.destroy());
    upstream.once('connect', () => {
      established = true;
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!established) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
    });
    client.on('close', () => upstream.destroy());
  }

  const server = createServer((incoming, response) => { void forward(incoming, response); });
  server.on('connect', (incoming: IncomingMessage, client: Duplex, head: Buffer) => { void tunnel(incoming, client, head); });
  const listenHost = options.listenHost ?? '127.0.0.1';
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, listenHost, () => { server.off('error', reject); resolveListening(); });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${listenHost}:${port}`,
    decisions: () => [...decided],
    rewritesApplied: () => [...applied.values()],
    close: () => new Promise<void>((resolveClosed) => {
      for (const socket of openSockets) socket.destroy();
      server.closeAllConnections();
      server.close(() => resolveClosed());
    }),
  };
}
