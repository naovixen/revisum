// The egress proxy as the main process of a run's proxy container. The runner passes the proxy's
// rules in one environment variable; the proxy listens on every interface of the container and
// appends each decision and each applied rewrite as a JSON line to a file in the container's private
// /tmp, which the runner reads back. For a workload's run it also answers name lookups and records
// them the same way. The rules and those lines all cross a process boundary, so each is decoded here
// before use. A write that fails does not stop the proxy: the state file says records were lost, and
// the runner decides what that means for the run.
import { EgressDecision, parseOrigin, type AppliedRewrite, type ProxyDecision } from '@revisum/contracts';
import { appendFileSync, openSync, writeSync } from 'node:fs';
import { startRefusalsServer } from './ReadBrowserRefusals.ts';
import { ownField } from '../egress-proxy/rules/OwnField.ts';
import { readProxyRules } from '../egress-proxy/rules/ParseProxyRules.ts';
import { ProxyClient } from '../egress-proxy/ProxyClient.ts';
import { startProxyServer } from '../egress-proxy/StartProxyServer.ts';
import { startLookupRecorder } from './StartLookupRecorder.ts';

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

// One decision line written by the proxy container, or null when the line is anything else.
export function readProxyDecision(line: string): ProxyDecision | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const origin = ownField(parsed, 'origin');
  const decision = ownField(parsed, 'decision');
  if (typeof origin !== 'string' || origin === '' || (decision !== 'allowed' && decision !== 'blocked')) {return null;}
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
  const origin = parseOrigin(ownField(parsed, 'origin'));
  const name = ownField(parsed, 'name');
  if (!origin.ok || typeof name !== 'string' || name === '') {return null;}
  return { origin: origin.value, name };
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
  if (!rules.ok) {
    console.error(`${RULES_VARIABLE} does not hold the egress proxy's rules: ${rules.error.message}`);
    return 2;
  }
  const records = startRecordKeeping(RECORDS_STATE_FILE);
  const hasRunAddresses = process.env[RUN_ADDRESSES_VARIABLE] === '1';
  const browserRefusals: string[] = [];
  // Up before the proxy, since a proxy that answers is taken to be ready.
  if (hasRunAddresses) {
    await startRefusalsServer(browserRefusals);
  }
  const started = await startProxyServer(rules.value, {
    listenHost: '0.0.0.0', port: PROXY_PORT,
    ...(hasRunAddresses ? { client: ProxyClient.Browser, servicePort: SERVICE_PROXY_PORT } : {}),
    onDecision: (decision, client) => {
      records.append(DECISIONS_FILE, decision);
      if (client === ProxyClient.Browser && decision.decision === EgressDecision.Blocked) {
        browserRefusals.push(decision.origin);
      }
    },
    onRewriteApplied: (applied) => records.append(REWRITES_FILE, applied),
    onListenerFailure: (failure) => console.error(`an egress proxy listener failed: ${failure.message}`),
  });
  if (!started.ok) {
    console.error(`the egress proxy did not start: ${started.error.message}`);
    return 1;
  }
  console.log(`egress proxy listening at ${started.value.url}`);
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

if (import.meta.main) {
  const exitCode = await main();
  // Exiting outright, since a failed proxy may leave the refusals server listening, which would keep
  // the container running with no proxy in it.
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
