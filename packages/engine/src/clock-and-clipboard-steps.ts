// Runs clock advances, clipboard checks and remembers from the clipboard through the session's
// clock and clipboard ports.
//   - An advance hands the driver its amount in milliseconds, once, and starts no real timer: it
//     never becomes a real wait.
//   - A clipboard check reads the clipboard's plain text and compares it, retrying until it passes
//     or the step times out, since a page copies asynchronously. The text is page content: it is
//     compared, never kept. A failed check says only "empty" or "differs", and an empty clipboard
//     fails every check, so textExcludes cannot pass on nothing.
//   - A remember from the clipboard keeps the text as a run value only when it passes the same
//     rules as plan text; the result and the log keep its name and sha256 only.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import type {
  AdvanceClockStep, ClipboardAssertion, Clock, DriverError, ExpectClipboardStep, Result, SafeText, Session, Step, ValueName,
} from '@revisum/contracts';
import { clockAdvanceMilliseconds } from './clock-advance.ts';
import { sha256 } from './hashing.ts';
import type { Logger } from './logging.ts';
import { runTimeText } from './plan/plan-decoders.ts';
import type { Project } from './project/project-parser.ts';
import { resolveText, type RunValues } from './run-values.ts';

// How long a clipboard check or remember waits between two reads of the clipboard.
const POLL_INTERVAL_MILLISECONDS = 50;

// What the run hands these steps. `values` and `rememberedTexts` are the run's own: a remember
// step adds to them.
export type ClockAndClipboardContext = {
  readonly project: Project;
  // The run's session, whose ports these steps use; null before one is open.
  readonly session: Session | null;
  readonly values: Map<ValueName, SafeText>;
  readonly rememberedTexts: Set<string>;
  readonly clock: Clock;
  readonly logger: Logger;
};

// What one of these steps gives its step result.
export type ClockAndClipboardOutcome = {
  readonly outcome: 'passed' | 'failed';
  readonly code?: string;
  // Only "empty" or "differs": never the clipboard's text.
  readonly observed?: string;
  readonly remembered?: { readonly valueName: ValueName; readonly sha256: string };
};

const passed: ClockAndClipboardOutcome = { outcome: 'passed' };
const failedWith = (code: string, observed?: string): ClockAndClipboardOutcome =>
  ({ outcome: 'failed', code, ...(observed === undefined ? {} : { observed }) });
const UNSUPPORTED = failedWith('unsupported-step');

// ---- Advancing the clock ----------------------------------------------------------------------

export async function advanceClock(step: AdvanceClockStep, context: ClockAndClipboardContext): Promise<ClockAndClipboardOutcome> {
  const port = context.session?.clock;
  if (port === undefined) return UNSUPPORTED;
  const advanced = await port.advance(clockAdvanceMilliseconds(step.by), step.mode ?? 'runTimers', context.project.limits.maximumTimersPerAdvance);
  return advanced.ok ? passed : failedWith(advanced.error.code);
}

// ---- Reading the clipboard --------------------------------------------------------------------

// One read of the clipboard: its text, or why there is none to look at.
type ClipboardRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'too-long' }
  | { readonly kind: 'error'; readonly error: DriverError };

async function readClipboard(session: Session, context: ClockAndClipboardContext): Promise<ClipboardRead> {
  const port = session.clipboard;
  if (port === undefined) return { kind: 'error', error: { code: 'unsupported-step', detail: 'the session has no clipboard port' } };
  const maximum = context.project.limits.maximumClipboardCharacters;
  const read: Result<string, DriverError> = await port.readText(maximum);
  if (!read.ok) return { kind: 'error', error: read.error };
  return read.value.length > maximum ? { kind: 'too-long' } : { kind: 'text', text: read.value };
}

// Reads the clipboard until `accept` takes what it holds, a read fails, or the step timeout runs
// out, and gives the last read.
async function readUntil(session: Session, context: ClockAndClipboardContext, accept: (read: ClipboardRead) => boolean): Promise<ClipboardRead> {
  const deadline = context.clock.now() + context.project.limits.stepTimeoutMilliseconds;
  for (;;) {
    const read = await readClipboard(session, context);
    if (read.kind === 'error' || accept(read) || context.clock.now() >= deadline) return read;
    await context.clock.sleep(POLL_INTERVAL_MILLISECONDS);
  }
}

// The text a check compares against, with value references replaced. Several lines are joined
// by "\n", as the clipboard's own line endings are.
function expectedText(assertion: ClipboardAssertion, values: RunValues, project: Project): Result<string, string> {
  const value = assertion.value;
  if (typeof value === 'object' && 'lines' in value) {
    const lines: string[] = [];
    for (const line of value.lines) {
      const text = resolveText(line, values, project.limits.maximumTextLength);
      if (!text.ok) return text;
      lines.push(text.value);
    }
    return { ok: true, value: lines.join('\n') };
  }
  return resolveText(value, values, project.limits.maximumTextLength);
}

// True when the clipboard's non-empty text passes the check.
function holds(assertion: ClipboardAssertion, text: string, expected: string): boolean {
  switch (assertion.kind) {
    case 'textEquals': return text === expected;
    case 'textContains': return text.includes(expected);
    case 'textExcludes': return !text.includes(expected);
  }
}

export async function checkClipboard(step: ExpectClipboardStep, context: ClockAndClipboardContext): Promise<ClockAndClipboardOutcome> {
  const session = context.session;
  if (session?.clipboard === undefined) return UNSUPPORTED;
  const expected = expectedText(step.assert, context.values, context.project);
  if (!expected.ok) return failedWith(expected.error);
  const read = await readUntil(session, context, (seen) => seen.kind === 'text' && seen.text !== '' && holds(step.assert, seen.text, expected.value));
  switch (read.kind) {
    case 'error': return failedWith(read.error.code);
    case 'too-long': return failedWith('value-too-long');
    case 'text':
      if (read.text === '') return failedWith('assertion-failed', 'empty');
      return holds(step.assert, read.text, expected.value) ? passed : failedWith('assertion-failed', 'differs');
  }
}

// A remember step that reads the clipboard. It waits, as a check does, for the page's copy to
// land; text that is still empty fails with value-empty. Multi-line text breaks the safe-text
// rules, so it fails with value-unsafe: a plan checks it with expectClipboard instead.
export async function rememberFromClipboard(
  step: Extract<Step, { type: 'remember' }>, index: number, context: ClockAndClipboardContext,
): Promise<ClockAndClipboardOutcome> {
  const session = context.session;
  if (session?.clipboard === undefined) return UNSUPPORTED;
  const read = await readUntil(session, context, (seen) => seen.kind !== 'text' || seen.text !== '');
  if (read.kind === 'error') return failedWith(read.error.code);
  if (read.kind === 'too-long') return failedWith('value-too-long');
  if (read.text === '') return failedWith('value-empty');
  const maximumLength = context.project.limits.maximumTextLength;
  if (read.text.length > maximumLength) return failedWith('value-too-long');
  const safe = runTimeText(read.text, maximumLength);
  if (safe === undefined) return failedWith('value-unsafe');
  context.values.set(step.name, safe);
  context.rememberedTexts.add(safe);
  const digest = sha256(safe);
  context.logger.log({ kind: 'value.remembered', stepIndex: index, valueName: step.name, sha256: digest });
  return { outcome: 'passed', remembered: { valueName: step.name, sha256: digest } };
}
