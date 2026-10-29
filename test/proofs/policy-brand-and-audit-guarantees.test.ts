// Two guarantees around the policy gate, each proved by compiling a small file on its own:
//   - Only the policy gate makes an Authorised plan. Adding the brand's own field to a parsed plan
//     by hand must not type-check, while the plan the gate returns still does.
//   - Every denial is recorded. A run either cannot be given ports without an audit sink (the
//     port is required, so leaving it out does not type-check), or, if it can, it refuses to start
//     without one rather than deny a plan with no record.
// See docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runUntrusted, type RunPorts } from '@revisum/engine';
import { memoryEventSink } from '../unit/engine/approval-repositories.ts';
import { finalState, guardedDriver, parserFor, portsWithoutAudit, runBase } from '../unit/engine/guarded-driver.ts';
import { CLOSING_CHECK, OPEN_ACCOUNT_PAGE, click, planOf, role } from '../unit/engine/policy-examples.ts';
import { compileFiles } from './scratch-compiler.ts';

const TIMEOUT = 300_000;

const compile = (name: string, lines: readonly string[]) => compileFiles([{ name, source: [...lines, ''].join('\n') }]);

// ---- Forging the Authorised brand --------------------------------------------------------------

const FORGERY_SETUP = [
  "import type { Authorised, Plan } from '@revisum/engine';",
  'declare const parsed: Plan;',
];

test('control: the plan the policy gate returns compiles as Authorised', { criterion: 'AC-SPEC-03-04', timeout: TIMEOUT }, () => {
  const compiled = compile('gate-output.ts', [
    "import type { Authorised, Plan, PolicyGate, Target } from '@revisum/engine';",
    'declare const gate: PolicyGate;',
    'declare const parsed: Plan;',
    'declare const targets: readonly Target[];',
    'const decision = gate.decide(parsed, targets);',
    'export const cleared: Authorised | null = decision.kind === \'allow\' ? decision.plan : null;',
  ]);
  assert.equal(compiled.passed, true, compiled.output);
});

test('a parsed plan spread into an object with the brand\'s field added by hand does not compile as Authorised', { criterion: 'AC-SPEC-03-04', timeout: TIMEOUT }, () => {
  const compiled = compile('forged-by-spread.ts', [
    ...FORGERY_SETUP,
    "export const forged: Authorised = { ...parsed, __authorisedBy: 'policy-gate' };",
  ]);
  assert.equal(compiled.passed, false, 'a hand-made Authorised plan compiled');
  assert.equal(compiled.errors.length, 1, compiled.output);
});

test('a parsed plan given the brand\'s field by Object.assign does not compile as Authorised', { criterion: 'AC-SPEC-03-04', timeout: TIMEOUT }, () => {
  const compiled = compile('forged-by-assign.ts', [
    ...FORGERY_SETUP,
    "export const forged: Authorised = Object.assign({}, parsed, { __authorisedBy: 'policy-gate' as const });",
  ]);
  assert.equal(compiled.passed, false, 'a hand-made Authorised plan compiled');
  assert.equal(compiled.errors.length, 1, compiled.output);
});

// ---- A run without an audit sink -----------------------------------------------------------------

const PORTS_SETUP = [
  "import type { ArtifactStore, BrowserDriver, Clock, EventSink, Redactor, RunEventSink, RunPorts } from '@revisum/engine';",
  'declare const drivers: ReadonlyMap<string, BrowserDriver>;',
  'declare const clock: Clock;',
  'declare const artifacts: ArtifactStore;',
  'declare const redactor: Redactor;',
  'declare const events: RunEventSink;',
  'declare const audit: EventSink;',
];

test('control: run ports with an audit sink compile', { criterion: 'AC-SPEC-03-05', timeout: TIMEOUT }, () => {
  const compiled = compile('ports-with-audit.ts', [...PORTS_SETUP, 'export const ports: RunPorts = { drivers, clock, artifacts, redactor, events, audit };']);
  assert.equal(compiled.passed, true, compiled.output);
});

const DELETE_STEPS = [OPEN_ACCOUNT_PAGE, click(role('button', 'Delete account'))];
const SAVE_STEPS = [OPEN_ACCOUNT_PAGE, click(role('button', 'Save changes'))];

test('a run cannot deny a plan without recording it: the audit port is required, or a run without one refuses to start', { criterion: 'AC-SPEC-03-05', timeout: TIMEOUT }, async () => {
  const compiled = compile('ports-without-audit.ts', [...PORTS_SETUP, 'export const ports: RunPorts = { drivers, clock, artifacts, redactor, events };']);
  if (!compiled.passed) {
    // The port is required: leaving it out is the one error, and it names the audit sink.
    assert.equal(compiled.errors.length, 1, compiled.output);
    assert.match(compiled.output, /audit/, compiled.output);
    return;
  }
  // The port is optional, so a run without one must refuse to start: neither deny unrecorded nor run.
  for (const steps of [DELETE_STEPS, SAVE_STEPS]) {
    const driven = guardedDriver([...steps, CLOSING_CHECK]);
    // Built as a caller that leaves the port out would; the cast keeps this file compiling once the port is required.
    const ports = portsWithoutAudit(driven.driver) as RunPorts;
    let state: string;
    try {
      state = finalState(await runUntrusted(planOf(steps), parserFor(), runBase(), ports));
    } catch {
      state = 'refused';
    }
    assert.notEqual(state, 'Denied', 'a plan was denied with no audit sink to record the denial');
    assert.notEqual(state, 'Passed', 'a plan ran with no audit sink to record a denial');
    assert.equal(driven.opens(), 0, 'a run with no audit sink opened a browser');
  }
});

test('with an audit sink, a denial is recorded and an allowed plan runs', { criterion: 'AC-SPEC-03-05' }, async () => {
  const audit = memoryEventSink();
  const denied = guardedDriver([...DELETE_STEPS, CLOSING_CHECK]);
  assert.equal(finalState(await runUntrusted(planOf(DELETE_STEPS), parserFor(), runBase(), { ...portsWithoutAudit(denied.driver), audit })), 'Denied');
  assert.deepEqual(audit.recorded.map(({ event }) => [event.kind, event.code]), [['plan.denied', 'irreversible-action']]);
  const allowed = guardedDriver([...SAVE_STEPS, CLOSING_CHECK]);
  assert.equal(finalState(await runUntrusted(planOf(SAVE_STEPS), parserFor(), runBase(), { ...portsWithoutAudit(allowed.driver), audit })), 'Passed');
});
