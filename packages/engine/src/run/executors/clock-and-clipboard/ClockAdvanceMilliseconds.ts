// How far advanceClock steps move the run's virtual clock, in milliseconds. Pure. The parser
// bounds each advance and a plan's total with these, and the run hands the driver milliseconds,
// so a unit is converted in this one place only.
import type { ClockAdvance, ClockUnit, Plan } from '@revisum/contracts';
import { visitSteps } from '../../../plan/VisitSteps.ts';

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

// Every advance in the plan added up, those inside frames and second tabs included. Plans are
// straight-line, so this is exactly how far the run's clock moves. A plan's cleanup holds only
// calls, so it adds nothing.
export function totalClockAdvanceMilliseconds(plan: Plan): number {
  let total = 0;
  visitSteps(plan.steps, (step) => {
    if (step.type === 'advanceClock') {
      total += clockAdvanceMilliseconds(step.by);
    }
  });
  return total;
}
