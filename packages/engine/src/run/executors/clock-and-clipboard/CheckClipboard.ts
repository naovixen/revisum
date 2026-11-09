// Runs clock advances, clipboard checks and remembers from the clipboard through the session's
// clock and clipboard ports.
//   - An advance hands the driver its amount in milliseconds, once, and starts no real timer: it
//     never becomes a real wait.
//   - A clipboard check reads the clipboard's plain text and compares it, retrying until it passes
//     or the step times out, since a page copies asynchronously. Text past the project's limit fails
//     at once, as a remember does: nothing says a later copy will fit. The text is page content: it is
//     compared, never kept. A failed check says only "empty" or "differs", and an empty clipboard
//     fails every check, so textExcludes cannot pass on nothing.
//   - A remember from the clipboard keeps the text as a run value only when it passes the same
//     rules as plan text; the result and the log keep its name and sha256 only.
import {
  ClipboardAssertionKind, ClipboardRead as ClipboardReadKind, stepFailed,
  type AdvanceClockStep, type ClipboardAssertion, type Clock, type DriverError, type ExpectClipboardStep, type Result, type Session, type Step, type StepCode, StepOutcome,
} from '@revisum/contracts';
import { clockAdvanceMilliseconds } from './ClockAdvanceMilliseconds.ts';
import type { Project } from '../../../project/ParseProject.ts';
import type { RememberedRecord, RememberedValues } from '../../values/RememberedValues.ts';
import { resolveText, type RunValues } from '../../values/RunValues.ts';
import { pollUntil } from '../../PollUntil.ts';

// How long a clipboard check or remember waits between two reads of the clipboard.
const POLL_INTERVAL_MILLISECONDS = 50;

// What the run hands these steps. `remembered` is how a remember step adds to the run's values.
export type ClockAndClipboardContext = {
  readonly project: Project;
  // The run's session, whose ports these steps use.
  readonly session: Session;
  readonly values: RunValues;
  readonly remembered: RememberedValues;
  readonly clock: Clock;
};

// What one of these steps gives its step result.
type ClockAndClipboardOutcome =
  | { readonly outcome: typeof StepOutcome.Passed; readonly remembered?: RememberedRecord }
  // Only "empty" or "differs": never the clipboard's text.
  | { readonly outcome: typeof StepOutcome.Failed; readonly code: StepCode; readonly observed?: string };

const passed: ClockAndClipboardOutcome = { outcome: StepOutcome.Passed };
const failedWith = (code: StepCode, observed?: string): ClockAndClipboardOutcome =>
  ({ ...stepFailed(code), ...(observed === undefined ? {} : { observed }) });

// ---- Advancing the clock ----------------------------------------------------------------------

export async function advanceClock(step: AdvanceClockStep, context: ClockAndClipboardContext): Promise<ClockAndClipboardOutcome> {
  const advanced = await context.session.clock.advance(clockAdvanceMilliseconds(step.by), step.mode ?? 'runTimers', context.project.limits.maximumTimersPerAdvance);
  return advanced.ok ? passed : failedWith(advanced.error.code);
}

// ---- Reading the clipboard --------------------------------------------------------------------

// One read of the clipboard: its text, or why there is none to look at.
type ClipboardRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'too-long' }
  | { readonly kind: 'error'; readonly error: DriverError };

async function readClipboard(context: ClockAndClipboardContext): Promise<ClipboardRead> {
  const maximum = context.project.limits.maximumClipboardCharacters;
  const read: Result<string, DriverError> = await context.session.clipboard.readText(maximum);
  if (!read.ok) {return { kind: 'error', error: read.error };}
  return read.value.length > maximum ? { kind: 'too-long' } : { kind: ClipboardReadKind.Text, text: read.value };
}

// Reads the clipboard until `accept` takes what it holds, a read fails, or the step timeout runs
// out, and gives the last read.
function readUntil(context: ClockAndClipboardContext, accept: (read: ClipboardRead) => boolean): Promise<ClipboardRead> {
  return pollUntil(context.clock, {
    timeoutMilliseconds: context.project.limits.stepTimeoutMilliseconds,
    intervalMilliseconds: POLL_INTERVAL_MILLISECONDS,
    isDone: (read) => read.kind === 'error' || accept(read),
  }, () => readClipboard(context));
}

// The text a check compares against, with value references replaced. Several lines are joined
// by "\n", as the clipboard's own line endings are.
function expectedText(assertion: ClipboardAssertion, values: RunValues, project: Project): Result<string, StepCode> {
  const value = assertion.value;
  if (typeof value === 'object' && 'lines' in value) {
    const lines: string[] = [];
    for (const line of value.lines) {
      const text = resolveText(line, values, project.limits.maximumTextLength);
      if (!text.ok) {return text;}
      lines.push(text.value);
    }
    return { ok: true, value: lines.join('\n') };
  }
  return resolveText(value, values, project.limits.maximumTextLength);
}

// True when the clipboard's non-empty text passes the check.
function holds(assertion: ClipboardAssertion, text: string, expected: string): boolean {
  switch (assertion.kind) {
    case ClipboardAssertionKind.TextEquals: return text === expected;
    case ClipboardAssertionKind.TextContains: return text.includes(expected);
    case ClipboardAssertionKind.TextExcludes: return !text.includes(expected);
  }
}

export async function checkClipboard(step: ExpectClipboardStep, context: ClockAndClipboardContext): Promise<ClockAndClipboardOutcome> {
  const expected = expectedText(step.assert, context.values, context.project);
  if (!expected.ok) {return failedWith(expected.error);}
  const read = await readUntil(context, (seen) => seen.kind === 'too-long' || (seen.kind === 'text' && seen.text !== '' && holds(step.assert, seen.text, expected.value)));
  switch (read.kind) {
    case 'error': return failedWith(read.error.code);
    case 'too-long': return failedWith('value-too-long');
    case 'text':
      if (read.text === '') {return failedWith('assertion-failed', 'empty');}
      return holds(step.assert, read.text, expected.value) ? passed : failedWith('assertion-failed', 'differs');
  }
}

// A remember step that reads the clipboard. It waits, as a check does, for the page's copy to
// land; text that is still empty fails with value-empty. Multi-line text breaks the safe-text
// rules, so it fails with value-unsafe: a plan checks it with expectClipboard instead.
export async function rememberFromClipboard(
  step: Extract<Step, { type: 'remember' }>, index: number, context: ClockAndClipboardContext,
): Promise<ClockAndClipboardOutcome> {
  const read = await readUntil(context, (seen) => seen.kind !== 'text' || seen.text !== '');
  if (read.kind === 'error') {return failedWith(read.error.code);}
  if (read.kind === 'too-long') {return failedWith('value-too-long');}
  if (read.text === '') {return failedWith('value-empty');}
  const kept = context.remembered.remember(step.name, read.text, index);
  return kept.ok ? { outcome: StepOutcome.Passed, remembered: kept.value } : failedWith(kept.error);
}
