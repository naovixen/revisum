// The egress proxy as the main process of a run's proxy container. The runner passes the proxy's
// rules in one environment variable; the proxy listens on every interface of the container and
// appends each decision as a JSON line to a file in the container's private /tmp, which the runner
// reads back. For a workload's run it also answers name lookups and records them the same way.
// Both the rules and the decision lines cross a process boundary, so each is decoded here before
// use. See docs/specs/SPEC-07-isolated-runner-and-egress.md and docs/specs/SPEC-35-evidence-mode.md.
import type { ProxyDecision, ResponseRewrite } from '@revisum/contracts';
import { appendFileSync } from 'node:fs';
import { startProxyServer, type ProxyRules, type RewriteRule, type TcpRelay } from './egress-proxy.ts';
import { startLookupRecorder } from './lookup-recorder.ts';

export const PROXY_PORT = 3128;
export const DECISIONS_FILE = '/tmp/egress-decisions.jsonl';
export const RULES_VARIABLE = 'EGRESS_PROXY_RULES';
// Set for a workload's proxy: it also answers the run network's name lookups and records each name
// in LOOKUPS_FILE, one JSON line each (lookup-recorder.ts).
export const LOOKUPS_VARIABLE = 'EGRESS_PROXY_RECORDS_LOOKUPS';
export const LOOKUPS_FILE = '/tmp/egress-lookups.jsonl';

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined;

// A URL origin written exactly as the URL parser would write it, such as "http://127.0.0.1:4310".
function readOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).origin === value ? value : null;
  } catch {
    return null;
  }
}

function readOrigins(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const origins = value.map(readOrigin);
  return origins.every((origin) => origin !== null) ? origins.filter((origin) => origin !== null) : null;
}

function readRewriteRule(value: unknown): RewriteRule | null {
  const origin = readOrigin(field(value, 'origin'));
  const rewrite = field(value, 'rewrite');
  const name = field(rewrite, 'name');
  const find = field(rewrite, 'find');
  const replace = field(rewrite, 'replace');
  if (origin === null || typeof name !== 'string' || typeof find !== 'string' || typeof replace !== 'string') return null;
  const decoded: ResponseRewrite = { name, find, replace };
  return { origin, rewrite: decoded };
}

// A host a relay connects to: a DNS name or an IP address, as a URL's host name holds it.
const RELAY_HOST = /^[A-Za-z0-9.:_-]{1,253}$/;

function readTcpRelay(value: unknown): TcpRelay | null {
  const host = field(value, 'host');
  const port = field(value, 'port');
  const isPrivate = field(value, 'private');
  if (typeof host !== 'string' || !RELAY_HOST.test(host) || typeof isPrivate !== 'boolean') return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port, private: isPrivate };
}

// The proxy's rules from their JSON text, or null when the text is not exactly that shape.
export function readProxyRules(text: string): ProxyRules | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const allowedOrigins = readOrigins(field(parsed, 'allowedOrigins'));
  const privateOrigins = readOrigins(field(parsed, 'privateOrigins'));
  const rawRewrites = field(parsed, 'rewrites');
  if (allowedOrigins === null || privateOrigins === null || !Array.isArray(rawRewrites)) return null;
  const rewrites = rawRewrites.map(readRewriteRule);
  if (!rewrites.every((rule) => rule !== null)) return null;
  const rules: ProxyRules = { allowedOrigins, privateOrigins, rewrites: rewrites.filter((rule) => rule !== null) };
  // TCP relays are present only for a database command's run.
  const rawRelays = field(parsed, 'tcpRelays');
  if (rawRelays === undefined) return rules;
  if (!Array.isArray(rawRelays)) return null;
  const tcpRelays = rawRelays.map(readTcpRelay);
  if (!tcpRelays.every((relay) => relay !== null)) return null;
  return { ...rules, tcpRelays: tcpRelays.filter((relay) => relay !== null) };
}

// One decision line written by the proxy container, or null when the line is anything else.
export function readProxyDecision(line: string): ProxyDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const origin = field(parsed, 'origin');
  const decision = field(parsed, 'decision');
  if (typeof origin !== 'string' || origin === '' || (decision !== 'allowed' && decision !== 'blocked')) return null;
  return { origin, decision };
}

async function main(): Promise<number> {
  const rules = readProxyRules(process.env[RULES_VARIABLE] ?? '');
  if (rules === null) {
    console.error(`${RULES_VARIABLE} does not hold the egress proxy's rules`);
    return 2;
  }
  const proxy = await startProxyServer(rules, {
    listenHost: '0.0.0.0', port: PROXY_PORT, onDecision: (decision) => appendFileSync(DECISIONS_FILE, `${JSON.stringify(decision)}\n`),
  });
  console.log(`egress proxy listening at ${proxy.url}`);
  if (process.env[LOOKUPS_VARIABLE] === '1') {
    // Without the recorder, egress is still blocked: only the record of ignored-proxy attempts is lost.
    try {
      await startLookupRecorder((name) => appendFileSync(LOOKUPS_FILE, `${JSON.stringify({ name })}\n`));
      console.log('recording name lookups on port 53');
    } catch (error) {
      console.error(`name lookups are not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
