// The bounds on advancing the clock, and the project limits behind them. Each advance is held to
// limits.maximumClockAdvanceMilliseconds, and a plan's advances together to
// limits.maximumTotalClockAdvanceMilliseconds: plans are straight-line, so the parser adds up every
// advanceClock step, those inside frame and newTab blocks included, and refuses the step at which
// the total passes the limit. The engine's pure clockAdvanceMilliseconds converts one advance to
// milliseconds (a day is 86,400,000 ms of elapsed time), and totalClockAdvanceMilliseconds sums a
// plan's. The project also bounds the timers one advance may fire and the clipboard text a check
// reads.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clockAdvanceMilliseconds, parseProject, totalClockAdvanceMilliseconds, type Project } from '@revisum/engine';
import { projectFileWith } from './run-value-examples.ts';
import {
  DEFAULT_MAXIMUM_CLIPBOARD_CHARACTERS, DEFAULT_MAXIMUM_CLOCK_ADVANCE, DEFAULT_MAXIMUM_TIMERS_PER_ADVANCE,
  DEFAULT_MAXIMUM_TOTAL_CLOCK_ADVANCE, HOUR, LARGEST_CLIPBOARD_CHARACTERS, LARGEST_CLOCK_ADVANCE, LARGEST_TIMERS_PER_ADVANCE, MINUTE,
  OPEN_ORDERS, SECOND, accepted, advanceClock, expectClipboard, frame, newTab, parserFor, planOf, rejection,
} from './clock-and-clipboard-examples.ts';

// ---- One advance in milliseconds -------------------------------------------------------------------

const CONVERSIONS = [
  { amount: 1, unit: 'milliseconds', milliseconds: 1 },
  { amount: 250, unit: 'milliseconds', milliseconds: 250 },
  { amount: 1, unit: 'seconds', milliseconds: 1000 },
  { amount: 599, unit: 'seconds', milliseconds: 599_000 },
  { amount: 10, unit: 'minutes', milliseconds: 600_000 },
  { amount: 1, unit: 'hours', milliseconds: 3_600_000 },
  { amount: 1, unit: 'days', milliseconds: 86_400_000 },
  { amount: 31, unit: 'days', milliseconds: 2_678_400_000 },
] as const;

for (const conversion of CONVERSIONS) {
  test(`an advance of ${conversion.amount} ${conversion.unit} is ${conversion.milliseconds} ms`, { criterion: 'AC-SPEC-34-08' }, () => {
    assert.equal(clockAdvanceMilliseconds({ amount: conversion.amount, unit: conversion.unit }), conversion.milliseconds);
  });
}

// Metamorphic: the same span written in a smaller unit gives the same milliseconds.
test('an advance written in a larger unit equals the same span written in the next smaller one', { criterion: 'AC-SPEC-34-08' }, () => {
  for (const amount of [1, 7, 59, 120]) {
    assert.equal(clockAdvanceMilliseconds({ amount, unit: 'days' }), clockAdvanceMilliseconds({ amount: amount * 24, unit: 'hours' }));
    assert.equal(clockAdvanceMilliseconds({ amount, unit: 'hours' }), clockAdvanceMilliseconds({ amount: amount * 60, unit: 'minutes' }));
    assert.equal(clockAdvanceMilliseconds({ amount, unit: 'minutes' }), clockAdvanceMilliseconds({ amount: amount * 60, unit: 'seconds' }));
    assert.equal(clockAdvanceMilliseconds({ amount, unit: 'seconds' }), clockAdvanceMilliseconds({ amount: amount * 1000, unit: 'milliseconds' }));
  }
});

// ---- A plan's total ---------------------------------------------------------------------------------

test('a plan with no advance has a total of 0 ms', { criterion: 'AC-SPEC-34-04' }, () => {
  assert.equal(totalClockAdvanceMilliseconds(accepted(parserFor(), planOf([OPEN_ORDERS]))), 0);
});

test('a plan\'s total adds every advance, those inside frames, a newTab and a frame inside the newTab included', { criterion: 'AC-SPEC-34-04' }, () => {
  const plan = accepted(parserFor(), planOf([
    advanceClock(1, 'seconds'), OPEN_ORDERS, advanceClock(10, 'minutes', 'skipAhead'),
    frame([advanceClock(250, 'milliseconds'), frame([advanceClock(2, 'minutes')])]),
    newTab([advanceClock(1, 'hours'), frame([advanceClock(30, 'seconds')])]),
  ]));
  assert.equal(totalClockAdvanceMilliseconds(plan), SECOND + 10 * MINUTE + 250 + 2 * MINUTE + HOUR + 30 * SECOND);
});

// ---- The step limit ---------------------------------------------------------------------------------

test('with the default limits an advance of one hour is accepted and one of an hour and a millisecond is refused as too_large', { criterion: 'AC-SPEC-34-04' }, () => {
  accepted(parserFor(), planOf([OPEN_ORDERS, advanceClock(DEFAULT_MAXIMUM_CLOCK_ADVANCE, 'milliseconds')]));
  for (const over of [advanceClock(DEFAULT_MAXIMUM_CLOCK_ADVANCE + 1, 'milliseconds'), advanceClock(61, 'minutes'), advanceClock(2, 'hours'), advanceClock(1, 'days')]) {
    const errors = rejection(parserFor(), planOf([OPEN_ORDERS, over]));
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.equal(errors[0]?.split(' ')[0], 'too_large', JSON.stringify(over));
    assert.ok((errors[0]?.split(' ')[1] ?? '').startsWith('$.steps[1].by'), JSON.stringify(errors));
  }
});

test('a project step limit of one minute refuses a 61-second advance and accepts a 60-second one', { criterion: 'AC-SPEC-34-04' }, () => {
  const tight = parserFor({}, { maximumClockAdvanceMilliseconds: MINUTE });
  accepted(tight, planOf([OPEN_ORDERS, advanceClock(60, 'seconds')]));
  const errors = rejection(tight, planOf([OPEN_ORDERS, advanceClock(61, 'seconds')]));
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['too_large']);
});

// ---- The plan limit ---------------------------------------------------------------------------------

// A step limit of one minute and a plan limit of two and a half minutes.
const tightParser = () => parserFor({}, { maximumClockAdvanceMilliseconds: MINUTE, maximumTotalClockAdvanceMilliseconds: 150 * SECOND });

test('advances that add up to exactly the plan limit are accepted', { criterion: 'AC-SPEC-34-04' }, () => {
  accepted(tightParser(), planOf([OPEN_ORDERS, advanceClock(1, 'minutes'), advanceClock(1, 'minutes'), advanceClock(30, 'seconds')]));
  accepted(tightParser(), planOf([OPEN_ORDERS, advanceClock(1, 'minutes'), frame([advanceClock(1, 'minutes')]), newTab([advanceClock(30, 'seconds')])]));
});

const OVER_TOTAL = [
  {
    name: 'the third top-level advance',
    steps: [OPEN_ORDERS, advanceClock(1, 'minutes'), advanceClock(1, 'minutes'), advanceClock(1, 'minutes')],
    path: '$.steps[3]',
  },
  {
    name: 'one millisecond over, at the last advance',
    steps: [OPEN_ORDERS, advanceClock(1, 'minutes'), advanceClock(1, 'minutes'), advanceClock(30_001, 'milliseconds')],
    path: '$.steps[3]',
  },
  {
    name: 'an advance inside a frame',
    steps: [OPEN_ORDERS, advanceClock(1, 'minutes'), advanceClock(1, 'minutes'), frame([advanceClock(31, 'seconds')])],
    path: '$.steps[3].steps[0]',
  },
  {
    name: 'an advance inside a newTab',
    steps: [OPEN_ORDERS, advanceClock(1, 'minutes'), newTab([advanceClock(31, 'seconds'), advanceClock(1, 'minutes')])],
    path: '$.steps[2].steps[1]',
  },
  {
    name: 'an advance inside a frame inside a newTab',
    steps: [OPEN_ORDERS, newTab([advanceClock(1, 'minutes'), frame([advanceClock(1, 'minutes'), frame([advanceClock(31, 'seconds')])])])],
    path: '$.steps[1].steps[1].steps[1].steps[0]',
  },
  {
    name: 'a top-level advance after advances inside nested frames',
    steps: [OPEN_ORDERS, frame([frame([advanceClock(1, 'minutes'), advanceClock(1, 'minutes')])]), advanceClock(31, 'seconds')],
    path: '$.steps[2]',
  },
  {
    name: 'the advance that passes the limit, not the later ones',
    steps: [OPEN_ORDERS, advanceClock(1, 'minutes'), advanceClock(1, 'minutes'), advanceClock(1, 'minutes'), advanceClock(1, 'minutes')],
    path: '$.steps[3]',
  },
];

for (const over of OVER_TOTAL) {
  test(`a plan whose advances pass the plan limit is refused with too_large at ${over.name}`, { criterion: 'AC-SPEC-34-04' }, () => {
    assert.deepEqual(rejection(tightParser(), planOf(over.steps)), [`too_large ${over.path}`]);
  });
}

test('with the default limits, 24 one-hour advances are accepted and a 25th is refused at its own step', { criterion: 'AC-SPEC-34-04' }, () => {
  const hours = (count: number) => Array.from({ length: count }, () => advanceClock(1, 'hours'));
  accepted(parserFor(), planOf([OPEN_ORDERS, ...hours(24)]));
  assert.deepEqual(rejection(parserFor(), planOf([OPEN_ORDERS, ...hours(25)])), ['too_large $.steps[25]']);
});

// Counter-example: a clipboard check between advances adds nothing to the total.
test('steps other than advances add nothing to the total', { criterion: 'AC-SPEC-34-04' }, () => {
  const plan = accepted(tightParser(), planOf([
    OPEN_ORDERS, advanceClock(1, 'minutes'), expectClipboard('textContains', '/invite/'), advanceClock(1, 'minutes'), advanceClock(30, 'seconds'),
  ]));
  assert.equal(totalClockAdvanceMilliseconds(plan), 150 * SECOND);
});

// ---- The project limits -----------------------------------------------------------------------------

function parsed(limits: Readonly<Record<string, number>> = {}): Project {
  const outcome = parseProject(projectFileWith({}, limits));
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return outcome.value;
}

function refusal(limits: Readonly<Record<string, unknown>>): string[] {
  const file = projectFileWith();
  const outcome = parseProject({ ...file, limits: { ...(file['limits'] as Record<string, unknown>), ...limits } });
  assert.equal(outcome.ok, false, `the project was accepted with ${JSON.stringify(limits)}`);
  return outcome.ok ? [] : outcome.error.map((error) => `${error.code} ${error.path}`);
}

// The project's limits as plain data, read by name.
const limitsOf = (project: Project): Readonly<Record<string, unknown>> => project.limits;

// Each limit, its default and its ceiling. `with` gives the other limits an accepted value needs,
// so a step limit is never tested above the plan limit.
const PROJECT_LIMITS = [
  {
    name: 'maximumClockAdvanceMilliseconds', defaultValue: DEFAULT_MAXIMUM_CLOCK_ADVANCE, largest: LARGEST_CLOCK_ADVANCE,
    with: { maximumTotalClockAdvanceMilliseconds: LARGEST_CLOCK_ADVANCE },
  },
  {
    name: 'maximumTotalClockAdvanceMilliseconds', defaultValue: DEFAULT_MAXIMUM_TOTAL_CLOCK_ADVANCE, largest: LARGEST_CLOCK_ADVANCE,
    with: { maximumClockAdvanceMilliseconds: 1000 },
  },
  { name: 'maximumTimersPerAdvance', defaultValue: DEFAULT_MAXIMUM_TIMERS_PER_ADVANCE, largest: LARGEST_TIMERS_PER_ADVANCE, with: {} },
  { name: 'maximumClipboardCharacters', defaultValue: DEFAULT_MAXIMUM_CLIPBOARD_CHARACTERS, largest: LARGEST_CLIPBOARD_CHARACTERS, with: {} },
] as const;

for (const limit of PROJECT_LIMITS) {
  test(`a project that sets no ${limit.name} gets ${limit.defaultValue}`, { criterion: 'AC-SPEC-34-04' }, () => {
    assert.equal(limitsOf(parsed())[limit.name], limit.defaultValue);
  });

  test(`a project may set ${limit.name} up to ${limit.largest}`, { criterion: 'AC-SPEC-34-04' }, () => {
    assert.equal(limitsOf(parsed({ ...limit.with, [limit.name]: limit.largest }))[limit.name], limit.largest);
    assert.equal(limitsOf(parsed({ ...limit.with, [limit.name]: 1000 }))[limit.name], 1000);
  });

  test(`${limit.name} over ${limit.largest}, negative, fractional or not a number is refused at the limit`, { criterion: 'AC-SPEC-34-04' }, () => {
    for (const value of [limit.largest + 1, -1, 1.5, '1000', null]) {
      const errors = refusal({ ...limit.with, [limit.name]: value });
      assert.deepEqual(errors.map((error) => error.split(' ')[1]), [`$.limits.${limit.name}`], JSON.stringify(value));
      // A known limit with a bad value, not a field the project file does not have.
      assert.notEqual(errors[0]?.split(' ')[0], 'unknown_field', JSON.stringify(value));
    }
  });
}

// Counter-example: a misspelt limit is a field the project file does not have.
test('a misspelt clock limit is refused as unknown_field', { criterion: 'AC-SPEC-34-04' }, () => {
  assert.deepEqual(refusal({ maximumClockAdvanceMillis: HOUR }), ['unknown_field $.limits.maximumClockAdvanceMillis']);
});
