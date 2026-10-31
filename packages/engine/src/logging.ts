// Privacy by construction: every field the engine may log is declared here, with why it is kept
// and for how long. The type system rejects any other field, and the run-time logger rejects it
// again for callers that bypass the types.
import type { Redactor } from '@revisum/contracts';

type FieldPolicy = { readonly type: 'string' | 'number'; readonly why: string; readonly retentionDays: number };

export const LOGGING_MANIFEST = {
  kind: { type: 'string', why: 'Event category from a closed set.', retentionDays: 30 },
  runId: { type: 'string', why: 'Correlates the events of one run. Derived from hashes, never from a person.', retentionDays: 30 },
  sequence: { type: 'number', why: 'Order of events in the append-only log.', retentionDays: 30 },
  state: { type: 'string', why: 'Run lifecycle state, for audit of the state machine.', retentionDays: 30 },
  targetId: { type: 'string', why: 'Which declared target ran.', retentionDays: 30 },
  adapter: { type: 'string', why: 'Which adapter and protocol ran the target.', retentionDays: 30 },
  stepIndex: { type: 'number', why: 'Position of the step in the plan.', retentionDays: 30 },
  stepType: { type: 'string', why: 'Step type from the closed plan language.', retentionDays: 30 },
  outcome: { type: 'string', why: 'passed, failed or skipped.', retentionDays: 30 },
  code: { type: 'string', why: 'Machine-readable failure code from a closed set.', retentionDays: 30 },
  detail: { type: 'string', why: 'Short diagnostic text. Always passed through the Redactor first.', retentionDays: 7 },
  artifact: { type: 'string', why: 'Name of an artefact produced by a capture step.', retentionDays: 30 },
  sha256: { type: 'string', why: 'Content hash of an artefact, of a service call response body, of a page script result, of a database command output or of a remembered value, for replay proofs. Never the body, result, output or value itself.', retentionDays: 30 },
  valueName: { type: 'string', why: 'Name of a run value a remember step read from the page. Never the value: its sha256 is logged instead.', retentionDays: 30 },
  findings: { type: 'number', why: 'Count of accessibility findings (rule ids live in the run result).', retentionDays: 30 },
  origin: { type: 'string', why: 'Origin (scheme, host, port) of a blocked request. Never path or query.', retentionDays: 7 },
  durationMilliseconds: { type: 'number', why: 'Step timing for performance budgets. Excluded from the result hash.', retentionDays: 30 },
} as const satisfies Record<string, FieldPolicy>;

export type LogField = keyof typeof LOGGING_MANIFEST;
type FieldValue<Field extends LogField> = (typeof LOGGING_MANIFEST)[Field]['type'] extends 'number' ? number : string;

// service.call: one request a declared call sent, by step, outcome, code, response sha256 and duration.
// value.remembered: a remember step kept a value from the page, by step, value name and sha256.
// page.script: one run of a page script, by step, outcome, code, result sha256 and duration.
// database.command: one run of a database command, by step, outcome, code, output sha256 and duration.
export const EVENT_KINDS = [
  'run.state', 'step.start', 'step.end', 'artifact', 'audit', 'network.blocked', 'service.call', 'value.remembered', 'page.script',
  'database.command',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// What a caller may log: a kind plus any subset of the manifest fields.
export type LogRecord = { readonly kind: EventKind } & {
  readonly [Field in Exclude<LogField, 'kind' | 'runId' | 'sequence'>]?: FieldValue<Field>;
};
// What the sink stores: the record plus the run id and sequence number.
export type LoggedEvent = LogRecord & { readonly runId: string; readonly sequence: number };

// Any key of Candidate that Shape does not declare must have type never, so it cannot be passed.
export type Exact<Candidate, Shape> = Candidate & { readonly [Key in Exclude<keyof Candidate, keyof Shape>]: never };

export interface Logger {
  log<Candidate extends LogRecord>(record: Exact<Candidate, LogRecord>): void;
}

// Where a run's events go. Append-only: no update, no delete.
export interface RunEventSink {
  append(event: LoggedEvent): void;
  read(): readonly LoggedEvent[];
}

const FIELDS = new Set<string>(Object.keys(LOGGING_MANIFEST));
// A sha256 field holding a hex digest carries no personal data, and a redaction pattern matching a
// run of its digits, as the phone pattern can, would break the hash a replay proof compares.
const HEX_DIGEST = /^[0-9a-f]{64}$/;

export class LoggingManifestViolation extends Error {}

// A logger bound to one run. It rejects fields outside the manifest and redacts every string value.
export function manifestLogger(sink: RunEventSink, redactor: Redactor, runId: string): Logger {
  let sequence = 0;
  return {
    log(record) {
      const kept: Record<string, string | number> = {};
      for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
        if (!FIELDS.has(key) || key === 'runId' || key === 'sequence') throw new LoggingManifestViolation(`field not in LOGGING_MANIFEST: ${key}`);
        if (typeof value === 'string') kept[key] = key === 'sha256' && HEX_DIGEST.test(value) ? value : redactor.text(value);
        else if (typeof value === 'number') kept[key] = value;
        else throw new LoggingManifestViolation(`field ${key} must be a string or number`);
      }
      sink.append(Object.freeze({ ...kept, runId, sequence: sequence++ }) as LoggedEvent);
    },
  };
}
