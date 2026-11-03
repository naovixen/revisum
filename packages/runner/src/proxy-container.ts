// The egress proxy as the main process of a run's proxy container. The runner passes the proxy's
// rules in one environment variable; the proxy listens on every interface of the container and
// appends each decision and each applied rewrite as a JSON line to a file in the container's private
// /tmp, which the runner reads back. For a workload's run it also answers name lookups and records
// them the same way. The rules and those lines all cross a process boundary, so each is decoded here
// before use. A write that fails does not stop the proxy: the state file says records were lost, and
// the runner decides what that means for the run.
import type { AppliedRewrite, ProxyDecision, ResponseRewrite } from '@revisum/contracts';
import { appendFileSync, openSync, writeSync } from 'node:fs';
import { startRefusalsServer } from './ReadBrowserRefusals.ts';
import { ProxyClient, startProxyServer, type ProxyRules, type RewriteRule, type TcpRelay } from './egress-proxy.ts';
import { startLookupRecorder } from './lookup-recorder.ts';

export const PROXY_PORT = 3128;
// Set for a run container's proxy. PROXY_PORT then treats its clients as browsers, and this port as
// services. Their requests look alike and a page could forge anything in one, so where each connects
// is all that can tell them apart. A workload's proxy has one address, which answers.
export const RUN_ADDRESSES_VARIABLE = 'EGRESS_PROXY_HAS_RUN_ADDRESSES';
export const SERVICE_PROXY_PORT = 3129;
// Where the run container is told to send its service calls.
export const SERVICE_PROXY_VARIABLE = 'SERVICE_PROXY';
export const DECISIONS_FILE = '/tmp/egress-decisions.jsonl';
export const REWRITES_FILE = '/tmp/egress-rewrites.jsonl';
export const RULES_VARIABLE = 'EGRESS_PROXY_RULES';
// Set for a workload's proxy: it also answers the run network's name lookups and records each name
// in LOOKUPS_FILE, one JSON line each (lookup-recorder.ts).
export const LOOKUPS_VARIABLE = 'EGRESS_PROXY_RECORDS_LOOKUPS';
export const LOOKUPS_FILE = '/tmp/egress-lookups.jsonl';
// Says whether every record reached its file. The two words have the same length on purpose: see
// startRecordKeeping.
export const RECORDS_STATE_FILE = '/tmp/egress-records-state';
const RECORDS_KEPT = 'kept';
export const RECORDS_LOST = 'lost';

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
  return origins.every((origin) => origin !== null) ? origins : null;
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
  const rules: ProxyRules = { allowedOrigins, privateOrigins, rewrites };
  // TCP relays are present only for a database command's run.
  const rawRelays = field(parsed, 'tcpRelays');
  if (rawRelays === undefined) return rules;
  if (!Array.isArray(rawRelays)) return null;
  const tcpRelays = rawRelays.map(readTcpRelay);
  if (!tcpRelays.every((relay) => relay !== null)) return null;
  return { ...rules, tcpRelays };
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

// One applied-rewrite line written by the proxy container, or null when the line is anything else.
export function readAppliedRewrite(line: string): AppliedRewrite | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const origin = readOrigin(field(parsed, 'origin'));
  const name = field(parsed, 'name');
  if (origin === null || typeof name !== 'string' || name === '') return null;
  return { origin, name };
}

export type RecordKeeper = { append(file: string, record: unknown): void };

// Appends each record as a JSON line. A flood can fill /tmp, and a throw here would end the proxy
// from inside a request's handler. The state file is written now, while there is room, and later
// overwritten in place, since a full /tmp has no room for a new file or a longer one.
export function startRecordKeeping(stateFile: string): RecordKeeper {
  const state = openSync(stateFile, 'w');
  writeSync(state, RECORDS_KEPT, 0);
  return {
    append(file, record) {
      try {
        appendFileSync(file, `${JSON.stringify(record)}\n`);
      } catch {
        try {
          writeSync(state, RECORDS_LOST, 0);
        } catch {
          // A stopped proxy cannot be read back, which the runner takes as records lost too.
          process.exit(1);
        }
      }
    },
  };
}

async function main(): Promise<number> {
  const rules = readProxyRules(process.env[RULES_VARIABLE] ?? '');
  if (rules === null) {
    console.error(`${RULES_VARIABLE} does not hold the egress proxy's rules`);
    return 2;
  }
  const records = startRecordKeeping(RECORDS_STATE_FILE);
  const hasRunAddresses = process.env[RUN_ADDRESSES_VARIABLE] === '1';
  const browserRefusals: string[] = [];
  // Up before the proxy, since a proxy that answers is taken to be ready.
  if (hasRunAddresses) {
    await startRefusalsServer(browserRefusals);
  }
  const proxy = await startProxyServer(rules, {
    listenHost: '0.0.0.0', port: PROXY_PORT,
    ...(hasRunAddresses ? { client: ProxyClient.Browser, servicePort: SERVICE_PROXY_PORT } : {}),
    onDecision: (decision, client) => {
      records.append(DECISIONS_FILE, decision);
      if (client === ProxyClient.Browser && decision.decision === 'blocked') {
        browserRefusals.push(decision.origin);
      }
    },
    onRewriteApplied: (applied) => records.append(REWRITES_FILE, applied),
  });
  console.log(`egress proxy listening at ${proxy.url}`);
  if (process.env[LOOKUPS_VARIABLE] === '1') {
    // Without the recorder, egress is still blocked: only the record of ignored-proxy attempts is lost.
    try {
      await startLookupRecorder((name) => records.append(LOOKUPS_FILE, { name }));
      console.log('recording name lookups on port 53');
    } catch (error) {
      console.error(`name lookups are not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
