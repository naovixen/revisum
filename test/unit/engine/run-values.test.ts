// Generated run values: unique text, unique email addresses, unique numbers and dates relative to
// the run's frozen clock. Each derives from the run's seed and clock start, so the same manifest
// gives the same values and a new run gives new ones. Dates use the target's time zone and locale.
// The generated value itself always comes from a parsed plan, so these tests see what a run sees.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateValue, isUnsafeText, parseProject, planParser, type Plan, type Project, type Target } from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';
import {
  ORIGIN, accepted, declaredValue, parserFor, planOf, projectWith, rejection, valueName, type JsonRecord,
} from './run-value-examples.ts';

const CLOCK_START = Date.UTC(2026, 10, 2, 9, 0, 0);
const SEED = 42;
const UNIQUE_PART = '[0-9a-z]{10}';

const project = projectWith();
const parsePlan = parserFor();
const targetOf = (owner: Project): Target => {
  const found = owner.matrix[0];
  assert.ok(found !== undefined, 'the project has a target');
  return found;
};

// One value of each kind, plus a second unique text, so that names can be compared.
const VALUES: JsonRecord = {
  orderCode: { kind: 'uniqueText', prefix: 'order' },
  otherCode: { kind: 'uniqueText', prefix: 'order' },
  contact: { kind: 'uniqueEmail', localPrefix: 'ada' },
  ticket: { kind: 'uniqueNumber', digits: 8 },
  due: { kind: 'date', day: { from: 'today', addDays: 3 }, format: 'yearMonthDay' },
};
const UNIQUE_NAMES = ['orderCode', 'otherCode', 'contact', 'ticket'];
const plan = accepted(parsePlan, planOf([], { values: VALUES }));

function generated(name: string, seed = SEED, clockStart = CLOCK_START, from: Plan = plan, owner: Project = project): string {
  return generateValue(valueName(name), declaredValue(from, name), seed, clockStart, targetOf(owner), owner);
}

// ---- Same inputs, same values; new inputs, new values -------------------------------------------

test('computing every generated value twice from the same seed, clock start, target and project gives identical text', { criterion: 'AC-SPEC-30-03' }, () => {
  for (const name of Object.keys(VALUES)) assert.equal(generated(name), generated(name), name);
});

test('a different seed changes every unique value', { criterion: 'AC-SPEC-30-03' }, () => {
  for (const name of UNIQUE_NAMES) assert.notEqual(generated(name, SEED), generated(name, SEED + 1), name);
});

test('a different clock start changes every unique value', { criterion: 'AC-SPEC-30-03' }, () => {
  for (const name of UNIQUE_NAMES) assert.notEqual(generated(name, SEED, CLOCK_START), generated(name, SEED, CLOCK_START + 1), name);
});

test('two unique texts with the same prefix but different names differ within one run', { criterion: 'AC-SPEC-30-03' }, () => {
  assert.notEqual(generated('orderCode'), generated('otherCode'));
});

// Counter-example: a date is not a unique value. It follows the clock, not the seed.
test('a date value is the same for every seed with the same clock start', { criterion: 'AC-SPEC-30-03' }, () => {
  assert.equal(generated('due', 1), generated('due', 2));
  assert.equal(generated('due', 1), '2026-11-05');
});

test('across 10,000 seeds no two unique texts collide', { criterion: 'AC-SPEC-30-03' }, () => {
  const seen = new Set<string>();
  for (let seed = 0; seed < 10_000; seed++) seen.add(generated('orderCode', seed));
  assert.equal(seen.size, 10_000);
});

test('a unique text is its prefix, a hyphen and 10 base-36 characters', { criterion: 'AC-SPEC-30-03' }, () => {
  for (let seed = 0; seed < 50; seed++) assert.match(generated('orderCode', seed), new RegExp(`^order-${UNIQUE_PART}$`));
});

// The unique part comes from the seed, the clock start and the value's name only, so the prefix,
// the kind, the target and the project do not change it.
test('the unique part depends only on seed, clock start and name: the same name gives the same part whatever the prefix or kind', { criterion: 'AC-SPEC-30-03' }, () => {
  const uniquePart = (text: string): string => {
    const found = new RegExp(`-(${UNIQUE_PART})(@|$)`).exec(text);
    assert.ok(found?.[1] !== undefined, `no unique part in ${text}`);
    return found[1];
  };
  const first = accepted(parsePlan, planOf([], { values: { code: { kind: 'uniqueText', prefix: 'order' } } }));
  const second = accepted(parsePlan, planOf([], { values: { code: { kind: 'uniqueText', prefix: 'invoice' } } }));
  const email = accepted(parsePlan, planOf([], { values: { code: { kind: 'uniqueEmail', localPrefix: 'ada' } } }));
  const otherProject = projectWith({ generatedEmailDomains: ['mail.test'] });
  for (let seed = 0; seed < 20; seed++) {
    const part = uniquePart(generated('code', seed, CLOCK_START, first));
    assert.equal(uniquePart(generated('code', seed, CLOCK_START, second)), part);
    assert.equal(uniquePart(generated('code', seed, CLOCK_START, email)), part);
    assert.equal(uniquePart(generated('code', seed, CLOCK_START, first, otherProject)), part);
  }
});

test('a unique number has exactly the declared digits and no leading zero, for 4 and for 12 digits', { criterion: 'AC-SPEC-30-03' }, () => {
  const numbers = accepted(parsePlan, planOf([], { values: { short: { kind: 'uniqueNumber', digits: 4 }, long: { kind: 'uniqueNumber', digits: 12 } } }));
  for (let seed = 0; seed < 200; seed++) {
    assert.match(generated('short', seed, CLOCK_START, numbers), /^[1-9][0-9]{3}$/);
    assert.match(generated('long', seed, CLOCK_START, numbers), /^[1-9][0-9]{11}$/);
  }
});

test('a unique number of 3 or 13 digits, or a fractional digit count, is refused at its path', { criterion: 'AC-SPEC-30-03' }, () => {
  for (const digits of [3, 13, 6.5]) {
    const errors = rejection(parsePlan, planOf([], { values: { ticket: { kind: 'uniqueNumber', digits } } }));
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.ok(errors[0]?.endsWith(' $.values.ticket.digits'), JSON.stringify(errors));
  }
});

test('every generated value passes the safe-text rules', { criterion: 'AC-SPEC-30-03' }, () => {
  for (const name of Object.keys(VALUES)) {
    for (let seed = 0; seed < 100; seed++) assert.equal(isUnsafeText(generated(name, seed)), false, `${name} with seed ${seed}`);
  }
});

// ---- Unique email addresses ---------------------------------------------------------------------

const emailPlan = (domain?: string): JsonRecord =>
  planOf([], { values: { contact: { kind: 'uniqueEmail', localPrefix: 'ada', ...(domain === undefined ? {} : { domain }) } } });

test('a unique email naming a domain the project does not declare is refused with unknown_value at that domain', { criterion: 'AC-SPEC-30-04' }, () => {
  assert.deepEqual(rejection(parsePlan, emailPlan('mail.test')), ['unknown_value $.values.contact.domain']);
  const declaring = parserFor({ generatedEmailDomains: ['mail.test', 'example.org'] });
  assert.deepEqual(rejection(declaring, emailPlan('example.com')), ['unknown_value $.values.contact.domain']);
});

test('the refusal of an undeclared email domain does not echo the domain', { criterion: 'AC-SPEC-30-04' }, () => {
  const parsed = parsePlan(emailPlan('private-marker-q7zx.test'));
  assert.equal(parsed.ok, false);
  assert.ok(!JSON.stringify(parsed).includes('private-marker-q7zx'), JSON.stringify(parsed));
});

test('with no domain declared in the project, a unique email is <localPrefix>-<unique part>@example.com', { criterion: 'AC-SPEC-30-04' }, () => {
  for (let seed = 0; seed < 50; seed++) assert.match(generated('contact', seed), new RegExp(`^ada-${UNIQUE_PART}@example\\.com$`));
});

test('a unique email takes the first declared domain by default, and a named declared domain when given', { criterion: 'AC-SPEC-30-04' }, () => {
  const owner = projectWith({ generatedEmailDomains: ['mail.test', 'example.org'] });
  const parse = planParser(owner);
  const byDefault = accepted(parse, emailPlan());
  const named = accepted(parse, emailPlan('example.org'));
  assert.match(generated('contact', SEED, CLOCK_START, byDefault, owner), new RegExp(`^ada-${UNIQUE_PART}@mail\\.test$`));
  assert.match(generated('contact', SEED, CLOCK_START, named, owner), new RegExp(`^ada-${UNIQUE_PART}@example\\.org$`));
});

test('every generated email address passes the safe-text rules', { criterion: 'AC-SPEC-30-04' }, () => {
  for (let seed = 0; seed < 200; seed++) assert.equal(isUnsafeText(generated('contact', seed)), false);
});

// ---- Dates from the fixture table ---------------------------------------------------------------

type DateCase = {
  readonly clockStart: string; readonly targetId: string; readonly from: string; readonly addDays: number;
  readonly format: string; readonly expected: string;
};
type DateTable = { readonly targets: readonly JsonRecord[]; readonly cases: readonly DateCase[] };

const table: DateTable = JSON.parse(readFileSync(join(FIXTURES, 'date-values', 'cases.json'), 'utf8'));

function dateProject(): Project {
  const parsed = parseProject({ origins: [ORIGIN], matrix: table.targets });
  if (!parsed.ok) throw new Error(`bad date project: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

test('the date table covers daylight saving, 31 January into February, 29 February, week starts and Tokyo against Los Angeles', { criterion: 'AC-SPEC-30-05' }, () => {
  const clockStarts = new Set(table.cases.map((dateCase) => dateCase.clockStart));
  for (const needed of ['2026-03-08T04:30:00.000Z', '2026-10-24T23:30:00.000Z', '2026-01-31T12:00:00.000Z', '2028-02-28T12:00:00.000Z', '2026-11-01T12:00:00.000Z', '2026-10-31T16:00:00.000Z']) {
    assert.ok(clockStarts.has(needed), needed);
  }
  assert.ok(table.cases.some((dateCase) => dateCase.from === 'startOfWeek'));
  assert.ok(table.cases.some((dateCase) => dateCase.targetId === 'tokyo-japanese') && table.cases.some((dateCase) => dateCase.targetId === 'los-angeles-english'));
  for (const format of ['yearMonthDay', 'dayOfMonth', 'monthAndYear', 'longDate', 'weekday', 'timestamp', 'epochMilliseconds']) {
    assert.ok(table.cases.some((dateCase) => dateCase.format === format), format);
  }
});

for (const dateCase of table.cases) {
  const title = `${dateCase.from} ${dateCase.addDays >= 0 ? '+' : ''}${dateCase.addDays} days as ${dateCase.format}, from ${dateCase.clockStart} in ${dateCase.targetId}, is "${dateCase.expected}"`;
  test(title, { criterion: 'AC-SPEC-30-05' }, () => {
    const owner = dateProject();
    const target = owner.matrix.find((candidate) => candidate.id === dateCase.targetId);
    assert.ok(target !== undefined, `no target ${dateCase.targetId}`);
    const raw = {
      ...planOf([], { values: { due: { kind: 'date', day: { from: dateCase.from, addDays: dateCase.addDays }, format: dateCase.format } } }),
      targets: [dateCase.targetId],
    };
    const datePlan = accepted(planParser(owner), raw);
    const text = generateValue(valueName('due'), declaredValue(datePlan, 'due'), SEED, Date.parse(dateCase.clockStart), target, owner);
    assert.equal(text, dateCase.expected);
  });
}

// The shared project's target is in Asia/Tokyo: from 18:00 on 2 November there, the day after the
// start of next month is 2 December, whose midnight in Tokyo is 15:00 on 1 December in UTC.
test('a timestamp and epoch milliseconds name midnight at the start of the day in the target\'s time zone', { criterion: 'AC-SPEC-30-05' }, () => {
  const both = accepted(parsePlan, planOf([], { values: {
    stamp: { kind: 'date', day: { from: 'startOfNextMonth', addDays: 1 }, format: 'timestamp' },
    epoch: { kind: 'date', day: { from: 'startOfNextMonth', addDays: 1 }, format: 'epochMilliseconds' },
  } }));
  assert.equal(generated('stamp', SEED, CLOCK_START, both), '2026-12-01T15:00:00.000Z');
  assert.equal(generated('epoch', SEED, CLOCK_START, both), String(Date.UTC(2026, 11, 1, 15, 0, 0)));
});

test('offsets of -3660 and 3660 days are accepted; -3661, 3661 and a fraction of a day are refused at addDays', { criterion: 'AC-SPEC-30-05' }, () => {
  const datePlan = (addDays: number): JsonRecord => planOf([], { values: { due: { kind: 'date', day: { from: 'today', addDays }, format: 'yearMonthDay' } } });
  for (const addDays of [-3660, 0, 3660]) accepted(parsePlan, datePlan(addDays));
  for (const addDays of [-3661, 3661, 1.5]) {
    const errors = rejection(parsePlan, datePlan(addDays));
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.ok(errors[0]?.endsWith(' $.values.due.day.addDays'), JSON.stringify(errors));
  }
});

test('an unknown date anchor or format is refused with unknown_value at its path', { criterion: 'AC-SPEC-30-05' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([], { values: { due: { kind: 'date', day: { from: 'endOfMonth', addDays: 0 }, format: 'yearMonthDay' } } })), ['unknown_value $.values.due.day.from']);
  assert.deepEqual(rejection(parsePlan, planOf([], { values: { due: { kind: 'date', day: { from: 'today', addDays: 0 }, format: 'shortDate' } } })), ['unknown_value $.values.due.format']);
});
