// Advancing the run's virtual clock and checking the clipboard: two kinds of step that let a plan
// test time-dependent behaviour and copy buttons without a script, a sleep or a real wait.
//
//   - advanceClock moves the page's Date and performance.now() forward by a whole amount of a
//     unit, firing the page's timers that come due on the way (runTimers) or once each after the
//     jump (skipAhead). The amount is bounded per step and per plan by the project's limits.
//   - expectClipboard checks the plain text of the run's own in-memory clipboard, and a remember
//     step may read that text into a run value. The text is page content: compared, never recorded.
//
// An advance never falls back to a real wait.
import type { Result } from '../../foundation/Result.ts';
import type { DriverError } from '../../errors/DriverError.ts';
import type { CriterionId } from '../CriterionId.ts';
import type { MultiLineText, TextOrValue } from '../TextOrValue.ts';
import type { StepType } from '../StepType.ts';

// The units an advance may be written in. A day is 86,400,000 ms of elapsed time; wall-clock
// dates follow from the new instant, so a daylight-saving change needs no special case. There is
// no week or month: a month's length varies.
export const ClockUnit = {
  Milliseconds: 'milliseconds',
  Seconds: 'seconds',
  Minutes: 'minutes',
  Hours: 'hours',
  Days: 'days',
} as const;
export type ClockUnit = (typeof ClockUnit)[keyof typeof ClockUnit];
export const CLOCK_UNITS: readonly ClockUnit[] = Object.values(ClockUnit);
// amount is a whole number, at least 1.
export type ClockAdvance = { readonly amount: number; readonly unit: ClockUnit };

// runTimers fires every timer that comes due within the advance, at its own virtual time, in
// due-time order. skipAhead jumps, then fires each timer now due once, as after a computer wakes
// from sleep. An advance without a mode runs timers.
export const ClockAdvanceMode = {
  RunTimers: 'runTimers',
  SkipAhead: 'skipAhead',
} as const;
export type ClockAdvanceMode = (typeof ClockAdvanceMode)[keyof typeof ClockAdvanceMode];
export const CLOCK_ADVANCE_MODES: readonly ClockAdvanceMode[] = Object.values(ClockAdvanceMode);

// Checks on the clipboard's plain text. An empty clipboard fails every one, so textExcludes cannot
// pass on nothing. Only textEquals may compare against several lines, joined by "\n".
export const ClipboardAssertionKind = {
  TextEquals: 'textEquals',
  TextContains: 'textContains',
  TextExcludes: 'textExcludes',
} as const;
export type ClipboardAssertionKind = (typeof ClipboardAssertionKind)[keyof typeof ClipboardAssertionKind];
export const CLIPBOARD_ASSERTION_KINDS: readonly ClipboardAssertionKind[] = Object.values(ClipboardAssertionKind);
export type ClipboardAssertion =
  | { readonly kind: typeof ClipboardAssertionKind.TextEquals; readonly value: TextOrValue | MultiLineText }
  | { readonly kind: typeof ClipboardAssertionKind.TextContains | typeof ClipboardAssertionKind.TextExcludes; readonly value: TextOrValue };

// What a remember step may read from the clipboard: its plain text only.
export const ClipboardRead = {
  Text: 'text',
} as const;
export type ClipboardRead = (typeof ClipboardRead)[keyof typeof ClipboardRead];
export const CLIPBOARD_READS: readonly ClipboardRead[] = Object.values(ClipboardRead);

// The plan steps of this file, as plan.ts's Step union holds them. Neither acts on an element, so
// the policy gate's runtime guard never sees them, and a proposal may hold both.
export type AdvanceClockStep = { readonly type: typeof StepType.AdvanceClock; readonly by: ClockAdvance; readonly mode?: ClockAdvanceMode };
export type ExpectClipboardStep = { readonly type: typeof StepType.ExpectClipboard; readonly assert: ClipboardAssertion; readonly criterionId: CriterionId };
export type ClockAndClipboardStep = AdvanceClockStep | ExpectClipboardStep;

// ---- The driver ports -------------------------------------------------------------------------
// The engine converts and bounds an advance's amount; a driver receives milliseconds.

export interface ClockPort {
  // Moves the virtual time of every frame and tab of the session forward; documents loaded later
  // start at the new time. Fails with clock-runaway once more than maximumTimers callbacks would
  // fire in this one advance, so a timer loop cannot hang a run.
  advance(milliseconds: number, mode: ClockAdvanceMode, maximumTimers: number): Promise<Result<void, DriverError>>;
}

export interface ClipboardPort {
  // The plain text of the run's own clipboard, line endings normalised to "\n", and "" when it is
  // empty. Gives at most maximumCharacters + 1 characters, so the engine can tell the limit was
  // passed. Fails with clipboard-unavailable when the browser cannot keep its clipboard in memory.
  readText(maximumCharacters: number): Promise<Result<string, DriverError>>;
}
