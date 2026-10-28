// How far advanceClock steps move the run's virtual clock, in milliseconds. Pure. The parser
// bounds each advance and a plan's total with these, and the run hands the driver milliseconds,
// so a unit is converted in this one place only.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import type { ClockAdvance, ClockUnit, Plan, Step } from '@revisum/contracts';

// Elapsed time, not calendar time: a day is always 86,400,000 ms, also across a daylight-saving change.
const MILLISECONDS_PER_UNIT: { readonly [Unit in ClockUnit]: number } = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

// One advance in milliseconds. An amount too large for a number gives Infinity, which every
// limit refuses.
export const clockAdvanceMilliseconds = (by: ClockAdvance): number => by.amount * MILLISECONDS_PER_UNIT[by.unit];

// The sum of the advances in `steps`, those inside frames and second tabs included.
function advancedMilliseconds(steps: readonly Step[]): number {
  let total = 0;
  for (const step of steps) {
    if (step.type === 'advanceClock') total += clockAdvanceMilliseconds(step.by);
    if (step.type === 'frame' || step.type === 'newTab') total += advancedMilliseconds(step.steps);
  }
  return total;
}

// Every advance in the plan added up. Plans are straight-line, so this is exactly how far the
// run's clock moves. A plan's cleanup holds only calls, so it adds nothing.
export const totalClockAdvanceMilliseconds = (plan: Plan): number => advancedMilliseconds(plan.steps);
