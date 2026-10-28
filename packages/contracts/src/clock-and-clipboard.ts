// Advancing the run's virtual clock and checking the clipboard: two kinds of step that let a plan
// test time-dependent behaviour and copy buttons without a script, a sleep or a real wait.
//
//   - advanceClock moves the page's Date and performance.now() forward by a whole amount of a
//     unit, firing the page's timers that come due on the way (runTimers) or once each after the
//     jump (skipAhead). The amount is bounded per step and per plan by the project's limits.
//   - expectClipboard checks the plain text of the run's own in-memory clipboard, and a remember
//     step may read that text into a run value. The text is page content: compared, never recorded.
//
// The driver ports that carry these out come with the CDP driver; until then a run reports both
// steps, and a remember from the clipboard, as unsupported-step.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import type { CriterionId, MultiLineText, TextOrValue } from './plan.ts';

// The units an advance may be written in. A day is 86,400,000 ms of elapsed time; wall-clock
// dates follow from the new instant, so a daylight-saving change needs no special case. There is
// no week or month: a month's length varies.
export const CLOCK_UNITS = ['milliseconds', 'seconds', 'minutes', 'hours', 'days'] as const;
export type ClockUnit = (typeof CLOCK_UNITS)[number];
// amount is a whole number, at least 1.
export type ClockAdvance = { readonly amount: number; readonly unit: ClockUnit };

// runTimers fires every timer that comes due within the advance, at its own virtual time, in
// due-time order. skipAhead jumps, then fires each timer now due once, as after a computer wakes
// from sleep. An advance without a mode runs timers.
export const CLOCK_ADVANCE_MODES = ['runTimers', 'skipAhead'] as const;
export type ClockAdvanceMode = (typeof CLOCK_ADVANCE_MODES)[number];

// Checks on the clipboard's plain text. An empty clipboard fails every one, so textExcludes cannot
// pass on nothing. Only textEquals may compare against several lines, joined by "\n".
export const CLIPBOARD_ASSERTION_KINDS = ['textEquals', 'textContains', 'textExcludes'] as const;
export type ClipboardAssertion =
  | { readonly kind: 'textEquals'; readonly value: TextOrValue | MultiLineText }
  | { readonly kind: 'textContains' | 'textExcludes'; readonly value: TextOrValue };

// What a remember step may read from the clipboard: its plain text only.
export const CLIPBOARD_READS = ['text'] as const;
export type ClipboardRead = (typeof CLIPBOARD_READS)[number];

// The plan steps of this file, as plan.ts's Step union holds them. Neither acts on an element, so
// the policy gate's runtime guard never sees them, and a proposal may hold both.
export type AdvanceClockStep = { readonly type: 'advanceClock'; readonly by: ClockAdvance; readonly mode?: ClockAdvanceMode };
export type ExpectClipboardStep = { readonly type: 'expectClipboard'; readonly assert: ClipboardAssertion; readonly criterionId: CriterionId };
export type ClockAndClipboardStep = AdvanceClockStep | ExpectClipboardStep;
