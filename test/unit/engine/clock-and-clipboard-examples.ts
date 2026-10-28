// Shared setup for the tests of advancing the run's virtual clock and checking the clipboard
// (plan language 1.2):
//
//   - advanceClock() builds the step that moves the page's clock forward by a whole amount of a
//     unit, in the default runTimers mode or in the mode given;
//   - expectClipboard() builds the assertion step on the clipboard's plain text, and
//     rememberClipboard() the remember step that reads it into a run value;
//   - the limits are the project defaults the spec gives, in milliseconds.
//
// Neither step needs a declaration in the trusted project, so every plan here parses against the
// shared test project (plan-examples.ts) with, at most, its limits changed.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import assert from 'node:assert/strict';
import type { JsonRecord } from './run-value-examples.ts';

export { NEW_VERSION, OPEN_ORDERS, ORIGIN, PREVIOUS_VERSION, accepted, parserFor, planOf, rejection, type JsonRecord, type ParsePlan } from './run-value-examples.ts';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// The project defaults and ceilings of the four new limits.
export const DEFAULT_MAXIMUM_CLOCK_ADVANCE = HOUR;
export const DEFAULT_MAXIMUM_TOTAL_CLOCK_ADVANCE = DAY;
export const LARGEST_CLOCK_ADVANCE = 31 * DAY;
export const DEFAULT_MAXIMUM_TIMERS_PER_ADVANCE = 10_000;
export const LARGEST_TIMERS_PER_ADVANCE = 100_000;
export const DEFAULT_MAXIMUM_CLIPBOARD_CHARACTERS = 20_000;
export const LARGEST_CLIPBOARD_CHARACTERS = 200_000;

export const advanceClock = (amount: unknown, unit: unknown, mode?: unknown): JsonRecord =>
  ({ type: 'advanceClock', by: { amount, unit }, ...(mode === undefined ? {} : { mode }) });

export const expectClipboard = (kind: unknown, value: unknown, criterionId = 'invite.link-copied'): JsonRecord =>
  ({ type: 'expectClipboard', assert: { kind, value }, criterionId });

export const rememberClipboard = (name: string): JsonRecord => ({ type: 'remember', name, from: { clipboard: 'text' } });

export const frame = (steps: readonly unknown[]): JsonRecord => ({ type: 'frame', locator: { by: 'testId', testId: 'session-frame' }, steps });
export const newTab = (steps: readonly unknown[]): JsonRecord => ({ type: 'newTab', url: '/orders', steps });

// A click on the page's copy button, which a clipboard check follows.
export const COPY_LINK: JsonRecord = { type: 'click', locator: { by: 'role', role: 'button', name: 'Copy invite link' } };

// Parts whose exact code or path the spec leaves to the parser: each is still refused, and every
// error is at the part or inside it.
export function assertRefusedInside(errors: readonly string[], path: string, label: string): void {
  assert.ok(errors.length > 0, `${label}: the plan was not refused`);
  for (const error of errors) {
    const found = error.split(' ')[1] ?? '';
    assert.ok(found === path || found.startsWith(`${path}.`) || found.startsWith(`${path}[`), `${label}: ${JSON.stringify(errors)}`);
  }
}
