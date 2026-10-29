// Decodes a Playwright trace archive, which arrives as raw bytes from the suite's output folder.
// The archive is read in memory by the zip reader (zip-reader.ts) under the evidence limits; then
// each ".trace" entry, one JSON event per line, is read by hand. Its first event carries the trace
// format version, and a version this decoder does not know is refused as trace-unsupported, never
// guessed at. What is kept is what a test did: the title of each action, in the order it started,
// and what the trace says about its own Playwright and browser, which Revisum cannot check.
// See docs/specs/SPEC-35-evidence-mode.md.
import { failure, success, type EvidenceLimits, type Result } from '@revisum/contracts';
import { brand } from '../brand.ts';
import type { SuiteDecodeError, SuiteTrace } from './suite-report.ts';
import { readZip } from './zip-reader.ts';

// The trace format versions this decoder reads: what the repository's pinned Playwright writes.
export const SUPPORTED_TRACE_VERSIONS: readonly number[] = [10];
const TRACE_ENTRY = /\.trace$/;
const CONTEXT_OPTIONS = 'context-options';
const ACTION_START = 'before';
const MAXIMUM_ACTION_TITLE_LENGTH = 2000;
// A self-reported version or browser name is kept only when it looks like one.
const VERSION_TEXT = /^\d{1,4}\.\d{1,4}\.\d{1,4}([-+.][0-9A-Za-z.-]{1,32})?$/;
const BROWSER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

type Event = Readonly<Record<string, unknown>>;
type ReadEvents = { readonly version: number; readonly browserName?: string; readonly playwrightVersion?: string; readonly actions: readonly { readonly start: number; readonly title: string }[] };

const fieldOf = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;

// One JSON line as an object, or null when it is not one.
function readEvent(line: string): Event | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return Object.fromEntries(['type', 'version', 'browserName', 'playwrightVersion', 'title', 'class', 'method', 'startTime']
    .map((key) => [key, fieldOf(parsed, key)]));
}

// What a step reads as: its own title, or its class and method when it has none.
function actionTitle(event: Event): string | null {
  const title = event['title'];
  if (typeof title === 'string' && title !== '') return title.slice(0, MAXIMUM_ACTION_TITLE_LENGTH);
  const className = event['class'];
  const method = event['method'];
  return typeof className === 'string' && typeof method === 'string' ? `${className}.${method}`.slice(0, MAXIMUM_ACTION_TITLE_LENGTH) : null;
}

function readTraceFile(text: string, path: string): Result<ReadEvents, SuiteDecodeError> {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const first = lines[0] === undefined ? null : readEvent(lines[0]);
  if (first === null || first['type'] !== CONTEXT_OPTIONS || typeof first['version'] !== 'number') return failure({ code: 'trace-invalid', path });
  const version = first['version'];
  if (!SUPPORTED_TRACE_VERSIONS.includes(version)) return failure({ code: 'trace-unsupported', path });
  const actions: { start: number; title: string }[] = [];
  for (const [index, line] of lines.entries()) {
    const event = readEvent(line);
    if (event === null) return failure({ code: 'trace-invalid', path: `${path}.lines[${index}]` });
    if (event['type'] !== ACTION_START) continue;
    const title = actionTitle(event);
    const start = event['startTime'];
    if (title !== null) actions.push({ start: typeof start === 'number' && Number.isFinite(start) ? start : actions.length, title });
  }
  const browserName = first['browserName'];
  const playwrightVersion = first['playwrightVersion'];
  return success({
    version, actions,
    ...(typeof browserName === 'string' && BROWSER_NAME.test(browserName) ? { browserName } : {}),
    ...(typeof playwrightVersion === 'string' && VERSION_TEXT.test(playwrightVersion) ? { playwrightVersion } : {}),
  });
}

// `attachmentPath` is where the report says the trace was attached, relative to Revisum's output
// folder, so the result builder can find the test it belongs to.
export function parseSuiteTrace(archive: Uint8Array, limits: EvidenceLimits, attachmentPath = ''): Result<SuiteTrace, SuiteDecodeError> {
  const read = readZip(archive, { maximumEntries: limits.maximumTraceEntries, maximumTotalBytes: limits.maximumTraceBytes });
  if (!read.ok) return failure({ code: read.error.code === 'too-large' ? 'too-large' : 'trace-invalid', path: read.error.path });
  const traceFiles = read.value.flatMap((entry, index) => (TRACE_ENTRY.test(entry.name) ? [{ entry, index }] : []));
  if (traceFiles.length === 0) return failure({ code: 'trace-invalid', path: '$' });
  const actions: { start: number; title: string }[] = [];
  let browserName: string | undefined;
  let playwrightVersion: string | undefined;
  for (const { entry, index } of traceFiles) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(entry.data);
    } catch {
      return failure({ code: 'trace-invalid', path: `$.entries[${index}]` });
    }
    const events = readTraceFile(text, `$.entries[${index}]`);
    if (!events.ok) return events;
    actions.push(...events.value.actions);
    browserName ??= events.value.browserName;
    playwrightVersion ??= events.value.playwrightVersion;
  }
  // A stable sort keeps file order for actions that started at the same time.
  const ordered = actions.map((action, order) => ({ ...action, order })).sort((left, right) => left.start - right.start || left.order - right.order);
  return success(brand<SuiteTraceFields, 'SuiteTrace'>({
    attachmentPath, actions: ordered.map((action) => action.title),
    ...(browserName === undefined ? {} : { browserName }),
    ...(playwrightVersion === undefined ? {} : { playwrightVersion }),
  }));
}

type SuiteTraceFields = {
  readonly attachmentPath: string; readonly actions: readonly string[]; readonly browserName?: string; readonly playwrightVersion?: string;
};
