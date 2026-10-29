// The plan grammar for advancing the clock and checking the clipboard (plan language 1.2). A plan
// may move the run's virtual clock forward by a whole amount of a unit, in runTimers or skipAhead
// mode, check the clipboard's plain text with textEquals, textContains or textExcludes, and
// remember it as a run value. Nothing a plan writes can sleep, wait real time, move the clock
// backwards, write the clipboard, paste, match a pattern or run a script. Every refusal gives a
// code and a JSON path, echoes no value from the plan, and happens before any driver, network or
// service call.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { afterEach, beforeEach, test } from 'node:test';
import { defaultRedactor, failure, runUntrusted, type BrowserDriver, type PlanErrorCode } from '@revisum/engine';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { PRIVATE_MARKER, defaultParser, signupPlan, stepsOf } from './plan-examples.ts';
import { projectWith } from './run-value-examples.ts';
import { fakeServiceCaller } from './service-call-examples.ts';
import {
  COPY_LINK, OPEN_ORDERS, ORIGIN, PREVIOUS_VERSION, accepted, advanceClock, assertRefusedInside, expectClipboard, frame, newTab,
  parserFor, planOf, rejection, rememberClipboard, type JsonRecord,
} from './clock-and-clipboard-examples.ts';

const parsePlan = parserFor();

const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const INVITE_VALUES: JsonRecord = { invitee: { kind: 'uniqueEmail', localPrefix: 'invitee' } };
const fillInviteLink: JsonRecord = { type: 'fill', locator: { by: 'label', label: 'Invite link' }, value: { valueName: 'inviteLink' } };

// ---- Plans the parser accepts --------------------------------------------------------------------

const ACCEPTED_ADVANCES: readonly { readonly name: string; readonly step: JsonRecord }[] = [
  { name: 'an advance of 1 millisecond', step: advanceClock(1, 'milliseconds') },
  { name: 'an advance of 599 seconds', step: advanceClock(599, 'seconds') },
  { name: 'an advance of 10 minutes', step: advanceClock(10, 'minutes') },
  { name: 'an advance of 1 hour, the default step limit', step: advanceClock(1, 'hours') },
  { name: 'an advance of 3,600,000 milliseconds, the default step limit', step: advanceClock(3_600_000, 'milliseconds') },
  { name: 'an advance in runTimers mode, written out', step: advanceClock(30, 'minutes', 'runTimers') },
  { name: 'an advance in skipAhead mode', step: advanceClock(30, 'minutes', 'skipAhead') },
];

for (const { name, step } of ACCEPTED_ADVANCES) {
  test(`${name} is accepted and kept as written`, { criterion: 'AC-SPEC-34-02' }, () => {
    const plan = accepted(parsePlan, planOf([OPEN_ORDERS, step]));
    assert.deepEqual(asJson(plan.steps[1]), step);
  });
}

test('an advance with no mode is accepted, and its amount and unit are kept', { criterion: 'AC-SPEC-34-02' }, () => {
  const plan = accepted(parsePlan, planOf([OPEN_ORDERS, advanceClock(5, 'minutes')]));
  const step = asJson(plan.steps[1]) as JsonRecord;
  assert.equal(step['type'], 'advanceClock');
  assert.deepEqual(step['by'], { amount: 5, unit: 'minutes' });
  assert.ok(step['mode'] === undefined || step['mode'] === 'runTimers', `the default mode is runTimers: ${JSON.stringify(step)}`);
});

test('an advance before the first navigation, and advances inside a frame and a newTab, are accepted', { criterion: 'AC-SPEC-34-02' }, () => {
  accepted(parsePlan, planOf([advanceClock(1, 'minutes'), OPEN_ORDERS]));
  accepted(parsePlan, planOf([OPEN_ORDERS, frame([advanceClock(1, 'minutes')]), newTab([advanceClock(1, 'minutes'), frame([advanceClock(1, 'seconds')])])]));
});

test('an advance in days is accepted when the project raises the step limit to 31 days', { criterion: 'AC-SPEC-34-02' }, () => {
  const roomy = parserFor({}, { maximumClockAdvanceMilliseconds: 31 * 86_400_000, maximumTotalClockAdvanceMilliseconds: 31 * 86_400_000 });
  const step = advanceClock(31, 'days');
  assert.deepEqual(asJson(accepted(roomy, planOf([OPEN_ORDERS, step])).steps[1]), step);
});

const ACCEPTED_CLIPBOARD: readonly { readonly name: string; readonly step: JsonRecord; readonly fields?: JsonRecord }[] = [
  { name: 'a textEquals clipboard check', step: expectClipboard('textEquals', 'https://example.test/invite/abc') },
  { name: 'a textContains clipboard check', step: expectClipboard('textContains', '/invite/') },
  { name: 'a textExcludes clipboard check', step: expectClipboard('textExcludes', 'password') },
  { name: 'a textEquals clipboard check against several lines', step: expectClipboard('textEquals', { lines: ['Ada Lovelace', '12 Analytical Row', 'London'] }) },
  { name: 'a textContains clipboard check against a run value', step: expectClipboard('textContains', { valueName: 'invitee' }), fields: { values: INVITE_VALUES } },
  { name: 'a textExcludes clipboard check against a run value', step: expectClipboard('textExcludes', { valueName: 'invitee' }), fields: { values: INVITE_VALUES } },
  { name: 'a textEquals clipboard check with a run value in its lines', step: expectClipboard('textEquals', { lines: ['Invite for', { valueName: 'invitee' }] }), fields: { values: INVITE_VALUES } },
];

for (const { name, step, fields } of ACCEPTED_CLIPBOARD) {
  test(`${name} is accepted and kept as written`, { criterion: 'AC-SPEC-34-03' }, () => {
    const plan = accepted(parsePlan, planOf([OPEN_ORDERS, COPY_LINK, step], fields));
    assert.deepEqual(asJson(plan.steps[2]), step);
  });
}

test('a remember from the clipboard is accepted, and a later fill and clipboard check may use the value', { criterion: 'AC-SPEC-34-03' }, () => {
  const steps = [OPEN_ORDERS, COPY_LINK, rememberClipboard('inviteLink'), fillInviteLink, expectClipboard('textEquals', { valueName: 'inviteLink' })];
  const plan = accepted(parsePlan, planOf(steps));
  assert.deepEqual(asJson(plan.steps.slice(0, steps.length)), steps);
});

test('a clipboard check and a clipboard remember are accepted inside a frame and a newTab', { criterion: 'AC-SPEC-34-03' }, () => {
  accepted(parsePlan, planOf([OPEN_ORDERS, frame([COPY_LINK, expectClipboard('textContains', '/invite/')])]));
  accepted(parsePlan, planOf([OPEN_ORDERS, newTab([COPY_LINK, rememberClipboard('inviteLink'), fillInviteLink])]));
});

// expectClipboard is an assertion step for the vacuity rule; advanceClock is not.
test('a plan whose only assertion is a clipboard check is accepted', { criterion: 'AC-SPEC-34-03' }, () => {
  const raw = { ...planOf([]), steps: [OPEN_ORDERS, COPY_LINK, expectClipboard('textContains', '/invite/')] };
  accepted(parsePlan, raw);
});

// Counter-example: a plan that only navigates and advances checks nothing, so it is vacuous.
test('a plan that only navigates and advances the clock, checking nothing, is refused as vacuous', { criterion: 'AC-SPEC-34-02' }, () => {
  const raw = { ...planOf([]), steps: [OPEN_ORDERS, advanceClock(10, 'minutes')] };
  const errors = rejection(parsePlan, raw);
  assert.deepEqual([...new Set(errors.map((error) => error.split(' ')[0]))], ['vacuous'], JSON.stringify(errors));
});

// ---- Refused plans --------------------------------------------------------------------------------

type RefusedCase = { readonly name: string; readonly plan: JsonRecord; readonly code: PlanErrorCode; readonly path: string };

// One refused step after opening the page: its index is 1.
const refusedStep = (name: string, step: JsonRecord, code: PlanErrorCode, path: string): RefusedCase =>
  ({ name, plan: planOf([OPEN_ORDERS, step]), code, path: `$.steps[1]${path}` });

const SCRIPT_TEXT = `<script>fetch("/steal?${PRIVATE_MARKER}")</script>`;
const CLIPBOARD_KINDS = ['textEquals', 'textContains', 'textExcludes'];

// Each case changes one thing in a step the parser accepts. Values from the plan are the private
// marker wherever a value, not a key, is wrong, so a test can see that no error echoes it.
const REFUSED_ADVANCES: readonly RefusedCase[] = [
  // ---- Amounts that are not a whole number of at least 1 ----
  refusedStep('an advance of 0', advanceClock(0, 'seconds'), 'wrong_type', '.by.amount'),
  refusedStep('an advance of -1', advanceClock(-1, 'seconds'), 'wrong_type', '.by.amount'),
  refusedStep('an advance of 1.5', advanceClock(1.5, 'seconds'), 'wrong_type', '.by.amount'),
  refusedStep('an advance of the text "15"', advanceClock('15', 'seconds'), 'wrong_type', '.by.amount'),
  refusedStep('an advance of other text', advanceClock(PRIVATE_MARKER, 'seconds'), 'wrong_type', '.by.amount'),
  refusedStep('an advance of null', advanceClock(null, 'seconds'), 'wrong_type', '.by.amount'),
  refusedStep('an advance with no amount', { type: 'advanceClock', by: { unit: 'seconds' } }, 'wrong_type', '.by.amount'),
  // ---- Units and modes the language does not have ----
  refusedStep('an unknown unit', advanceClock(1, PRIVATE_MARKER), 'unknown_value', '.by.unit'),
  refusedStep('a unit of weeks', advanceClock(1, 'weeks'), 'unknown_value', '.by.unit'),
  refusedStep('a unit of months, whose length varies', advanceClock(1, 'months'), 'unknown_value', '.by.unit'),
  refusedStep('an unknown mode', advanceClock(1, 'seconds', PRIVATE_MARKER), 'unknown_value', '.mode'),
  refusedStep('a mode that waits real time', advanceClock(1, 'seconds', 'realTime'), 'unknown_value', '.mode'),
  refusedStep('a mode that moves the clock backwards', advanceClock(1, 'seconds', 'backwards'), 'unknown_value', '.mode'),
  // ---- Fields an advance may never have ----
  ...['script', 'sleep', 'until', 'to', 'at'].map((field) =>
    refusedStep(`an advance with its own ${field}`, { ...advanceClock(1, 'seconds'), [field]: PRIVATE_MARKER }, 'unknown_field', `.${field}`)),
  refusedStep('an advance whose amount has its own time zone', { type: 'advanceClock', by: { amount: 1, unit: 'seconds', timezone: PRIVATE_MARKER } }, 'unknown_field', '.by.timezone'),
  // ---- Steps the language does not have ----
  refusedStep('a sleep step', { type: 'sleep', milliseconds: 1000, note: PRIVATE_MARKER }, 'unknown_step', '.type'),
  refusedStep('a wait step', { type: 'wait', for: PRIVATE_MARKER }, 'unknown_step', '.type'),
  refusedStep('a step that sets the clock to a time', { type: 'setClock', to: PRIVATE_MARKER }, 'unknown_step', '.type'),
  refusedStep('a step that pauses the clock', { type: 'pauseClock' }, 'unknown_step', '.type'),
];

const REFUSED_CLIPBOARD: readonly RefusedCase[] = [
  // ---- Clipboard steps the language does not have ----
  refusedStep('a writeClipboard step', { type: 'writeClipboard', text: PRIVATE_MARKER }, 'unknown_step', '.type'),
  refusedStep('a setClipboard step', { type: 'setClipboard', text: PRIVATE_MARKER }, 'unknown_step', '.type'),
  refusedStep('a paste step', { type: 'paste', locator: { by: 'label', label: 'Invite link' } }, 'unknown_step', '.type'),
  // ---- Fields a clipboard check may never have ----
  refusedStep('a clipboard check with a pattern', { ...expectClipboard('textContains', 'invite'), assert: { kind: 'textContains', value: 'invite', pattern: PRIVATE_MARKER } }, 'unknown_field', '.assert.pattern'),
  refusedStep('a clipboard check with a regex', { ...expectClipboard('textContains', 'invite'), assert: { kind: 'textContains', value: 'invite', regex: PRIVATE_MARKER } }, 'unknown_field', '.assert.regex'),
  refusedStep('a clipboard check whose assertion has a script', { ...expectClipboard('textContains', 'invite'), assert: { kind: 'textContains', value: 'invite', script: PRIVATE_MARKER } }, 'unknown_field', '.assert.script'),
  refusedStep('a clipboard check step with a script', { ...expectClipboard('textContains', 'invite'), script: PRIVATE_MARKER }, 'unknown_field', '.script'),
  refusedStep('a clipboard check with a locator', { ...expectClipboard('textContains', 'invite'), locator: { by: 'label', label: PRIVATE_MARKER } }, 'unknown_field', '.locator'),
  refusedStep('a clipboard check that names a format', { ...expectClipboard('textContains', 'invite'), format: 'text/html' }, 'unknown_field', '.format'),
  refusedStep('a clipboard check kind the language does not have', expectClipboard(PRIVATE_MARKER, 'invite'), 'unknown_value', '.assert.kind'),
  refusedStep('a clipboard check that matches a pattern', expectClipboard('textMatches', PRIVATE_MARKER), 'unknown_value', '.assert.kind'),
  // ---- Expected text ----
  ...CLIPBOARD_KINDS.map((kind) => refusedStep(`script-like expected text for ${kind}`, expectClipboard(kind, SCRIPT_TEXT), 'unsafe_text', '.assert.value')),
  refusedStep('a script-like line in multi-line expected text', expectClipboard('textEquals', { lines: ['Ada Lovelace', SCRIPT_TEXT] }), 'unsafe_text', '.assert.value.lines[1]'),
  ...CLIPBOARD_KINDS.map((kind) => refusedStep(`empty expected text for ${kind}`, expectClipboard(kind, ''), 'vacuous', '.assert.value')),
  ...CLIPBOARD_KINDS.map((kind) => refusedStep(`a ${kind} against a value never defined`, expectClipboard(kind, { valueName: 'neverSet' }), 'undefined_value', '.assert.value')),
  refusedStep('a line referring to a value never defined', expectClipboard('textEquals', { lines: ['Invite for', { valueName: 'neverSet' }] }), 'undefined_value', '.assert.value.lines[1]'),
  // ---- Clipboard sources the language does not have ----
  refusedStep('a remember of the clipboard as HTML', { type: 'remember', name: 'inviteLink', from: { clipboard: 'html' } }, 'unknown_value', '.from.clipboard'),
  refusedStep('a remember of an unknown clipboard format', { type: 'remember', name: 'inviteLink', from: { clipboard: PRIVATE_MARKER } }, 'unknown_value', '.from.clipboard'),
  refusedStep('a remember of the clipboard with a format field', { type: 'remember', name: 'inviteLink', from: { clipboard: 'text', format: PRIVATE_MARKER } }, 'unknown_field', '.from.format'),
  // A check that uses a remembered value before the remember that defines it.
  {
    name: 'a clipboard check of a value remembered only after it',
    plan: planOf([OPEN_ORDERS, expectClipboard('textContains', { valueName: 'inviteLink' }), COPY_LINK, rememberClipboard('inviteLink')]),
    code: 'undefined_value', path: '$.steps[1].assert.value',
  },
];

for (const refused of REFUSED_ADVANCES) {
  test(`${refused.name} is refused with ${refused.code} at ${refused.path}`, { criterion: 'AC-SPEC-34-02' }, () => {
    assert.deepEqual(rejection(parsePlan, refused.plan), [`${refused.code} ${refused.path}`]);
  });
}

for (const refused of REFUSED_CLIPBOARD) {
  test(`${refused.name} is refused with ${refused.code} at ${refused.path}`, { criterion: 'AC-SPEC-34-03' }, () => {
    assert.deepEqual(rejection(parsePlan, refused.plan), [`${refused.code} ${refused.path}`]);
  });
}

// An amount of 1e308 is a whole number, so it is over the step limit, not of the wrong type. The
// spec leaves open whether the error sits at the amount or at `by`.
for (const unit of ['milliseconds', 'days']) {
  test(`an advance of 1e308 ${unit} is refused with too_large at its amount`, { criterion: 'AC-SPEC-34-02' }, () => {
    const errors = rejection(parsePlan, planOf([OPEN_ORDERS, advanceClock(1e308, unit)]));
    assertRefusedInside(errors, '$.steps[1].by', `1e308 ${unit}`);
    assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['too_large']);
    assert.ok(!errors.join(' ').includes('308'), `the amount is not echoed: ${JSON.stringify(errors)}`);
  });
}

function assertNoEcho(cases: readonly RefusedCase[], fewest: number): void {
  const withMarker = cases.filter((refused) => JSON.stringify(refused.plan).includes(PRIVATE_MARKER));
  assert.ok(withMarker.length >= fewest, 'most cases carry the private marker');
  for (const refused of withMarker) {
    const parsed = parsePlan(refused.plan);
    assert.equal(parsed.ok, false, refused.name);
    assert.ok(!JSON.stringify(parsed).includes(PRIVATE_MARKER), `${refused.name}: ${JSON.stringify(parsed)}`);
  }
}

test('no refusal of an advance echoes the value the plan wrote', { criterion: 'AC-SPEC-34-02' }, () => {
  assertNoEcho(REFUSED_ADVANCES, 12);
});

test('no refusal of a clipboard step echoes the value the plan wrote', { criterion: 'AC-SPEC-34-03' }, () => {
  assertNoEcho(REFUSED_CLIPBOARD, 15);
});

test('an advance with no unit, or with a by that is not an object, is refused at by', { criterion: 'AC-SPEC-34-02' }, () => {
  for (const by of [{ amount: 1 }, 1000, '10 minutes', null, []]) {
    assertRefusedInside(rejection(parsePlan, planOf([OPEN_ORDERS, { type: 'advanceClock', by }])), '$.steps[1].by', JSON.stringify(by));
  }
});

test('an advance with no by at all is refused at the step', { criterion: 'AC-SPEC-34-02' }, () => {
  assertRefusedInside(rejection(parsePlan, planOf([OPEN_ORDERS, { type: 'advanceClock' }])), '$.steps[1]', 'no by');
});

test('multi-line expected text is refused for textContains and textExcludes, at the value', { criterion: 'AC-SPEC-34-03' }, () => {
  for (const kind of ['textContains', 'textExcludes']) {
    const errors = rejection(parsePlan, planOf([OPEN_ORDERS, expectClipboard(kind, { lines: ['Ada Lovelace', 'London'] })]));
    assertRefusedInside(errors, '$.steps[1].assert.value', kind);
    assert.ok(errors.every((error) => ['wrong_type', 'unknown_field'].includes(error.split(' ')[0] ?? '')), `${kind}: ${JSON.stringify(errors)}`);
  }
});

test('a clipboard check against a secret is refused at the value', { criterion: 'AC-SPEC-34-03' }, () => {
  for (const kind of CLIPBOARD_KINDS) {
    assertRefusedInside(rejection(parsePlan, planOf([OPEN_ORDERS, expectClipboard(kind, { secretName: 'SHOP_API_TOKEN' })])), '$.steps[1].assert.value', kind);
  }
});

test('a clipboard check without a criterion id is refused', { criterion: 'AC-SPEC-34-03' }, () => {
  const { criterionId: _removed, ...untraced } = expectClipboard('textContains', '/invite/');
  assertRefusedInside(rejection(parsePlan, planOf([OPEN_ORDERS, untraced])), '$.steps[1]', 'no criterion id');
});

test('a clipboard value remembered under the name of a generated value is refused as duplicate', { criterion: 'AC-SPEC-34-03' }, () => {
  const errors = rejection(parsePlan, planOf([OPEN_ORDERS, COPY_LINK, rememberClipboard('invitee')], { values: INVITE_VALUES }));
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['duplicate']);
});

// Counter-example for the refusals above: the closing check alone, with the page opened, parses.
test('counter-example: the plan around every refused step parses without it', { criterion: 'AC-SPEC-34-02' }, () => {
  accepted(parsePlan, planOf([OPEN_ORDERS]));
});

// ---- Version 1.1 ----------------------------------------------------------------------------------

test('a plan declaring 1.1 that advances the clock, checks the clipboard or remembers it is refused as a 1.1 parser refuses it', { criterion: 'AC-SPEC-34-01' }, () => {
  const parse = defaultParser();
  assert.equal(signupPlan()['version'], PREVIOUS_VERSION);
  const previousWith = (added: JsonRecord): JsonRecord => {
    const steps = [...stepsOf(signupPlan())];
    steps.splice(1, 0, added);
    return { ...signupPlan(), steps };
  };
  for (const step of [advanceClock(10, 'minutes'), advanceClock(10, 'minutes', 'skipAhead'), expectClipboard('textContains', '/invite/'), rememberClipboard('inviteLink')]) {
    assert.deepEqual(rejection(parse, previousWith(step)), ['unknown_step $.steps[1].type'], JSON.stringify(step));
  }
});

// Counter-example: the same 1.1 plan without the added step parses.
test('counter-example: the 1.1 sign-up plan parses unchanged', { criterion: 'AC-SPEC-34-01' }, () => {
  accepted(defaultParser(), signupPlan());
});

// ---- No driver, network or service call for a refused plan -----------------------------------------

let networkRequests = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  networkRequests = 0;
  globalThis.fetch = async () => { networkRequests++; throw new Error('no network in this test'); };
});
afterEach(() => { globalThis.fetch = realFetch; });

function countingPorts() {
  const counts = { driverCalls: 0 };
  const spy: BrowserDriver = {
    info: { id: 'playwright', version: 'spy', protocol: 'none' },
    supports() { counts.driverCalls++; return { ok: true, value: true }; },
    async open() { counts.driverCalls++; return failure({ reason: 'launch-failed', detail: 'the spy never launches' }); },
  };
  const { caller, requests } = fakeServiceCaller();
  const events = memoryRunEventSink();
  const ports = {
    drivers: new Map([['playwright', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), audit: memoryEventSink(), events, services: caller,
  };
  return { ports, counts, requests, events };
}

const base = () => ({ project: projectWith(), baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() } });

async function assertNothingReached(plans: readonly JsonRecord[]): Promise<void> {
  const { ports, counts, requests, events } = countingPorts();
  assert.ok(plans.length >= 15, 'enough hostile plans');
  for (const plan of plans) {
    const outcome = await runUntrusted(plan, parsePlan, base(), ports);
    assert.ok('errors' in outcome, JSON.stringify(outcome));
  }
  assert.equal(counts.driverCalls, 0, 'no driver method was called');
  assert.equal(networkRequests, 0, 'no network request was made');
  assert.equal(requests.length, 0, 'no service call was made');
  assert.equal(events.read().length, 0, 'nothing was logged');
}

test('every refused plan that advances the clock reaches no driver, network or service caller, and nothing is logged', { criterion: 'AC-SPEC-34-02' }, async () => {
  await assertNothingReached([...REFUSED_ADVANCES.map((refused) => refused.plan), planOf([OPEN_ORDERS, advanceClock(1e308, 'milliseconds')])]);
});

test('every refused plan with a clipboard step reaches no driver, network or service caller, and nothing is logged', { criterion: 'AC-SPEC-34-03' }, async () => {
  await assertNothingReached(REFUSED_CLIPBOARD.map((refused) => refused.plan));
});

// Counter-example: an accepted plan with an advance and a clipboard check does reach the driver,
// so the zero above can fail.
test('counter-example: an accepted plan that advances the clock and checks the clipboard reaches the driver', { criterion: 'AC-SPEC-34-02' }, async () => {
  const { ports, counts } = countingPorts();
  await runUntrusted(planOf([OPEN_ORDERS, advanceClock(10, 'minutes'), COPY_LINK, expectClipboard('textContains', '/invite/')]), parsePlan, base(), ports);
  assert.ok(counts.driverCalls > 0, 'the driver was asked to open a session');
});
