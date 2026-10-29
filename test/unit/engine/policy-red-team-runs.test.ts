// The red-team set, run end to end: each harmful plan goes through runUntrusted(), as an AI's plan
// would, on a driver that honours the runtime guard it is given. Each must end Denied with no input
// event for the denied step, never Failed or Passed; each benign twin must pass. The red-team test
// beside this one asks the gate directly; this one proves run() lets the guard decide, for every
// action kind, the dialog step included.
//
// The real CDP and Playwright drivers ignore the guard until SPEC-06 wires it in, so they are not
// run here.
// See docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runUntrusted, type PolicyRuleId } from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';
import { memoryEventSink } from './approval-repositories.ts';
import { finalState, guardedDriver, onlyRun, parserFor, portsWithoutAudit, runBase, type PageViews } from './guarded-driver.ts';
import { CLOSING_CHECK, planOf, type JsonRecord } from './policy-examples.ts';

type Variant = { readonly target?: string; readonly steps: readonly JsonRecord[]; readonly page?: PageViews };
type RedTeamCase = {
  readonly name: string;
  readonly actionKind: string;
  readonly stage: 'static' | 'runtime';
  readonly target: string;
  readonly deniedStep: number | null;
  readonly rule: PolicyRuleId;
  readonly harmful: Variant;
  readonly benign: Variant;
};

const RED_TEAM: readonly RedTeamCase[] =
  JSON.parse(readFileSync(join(FIXTURES, 'policy-red-team', 'cases.json'), 'utf8')).cases;

async function runVariant(variant: Variant, targetId: string) {
  const steps = [...variant.steps, CLOSING_CHECK];
  const driven = guardedDriver(steps, variant.page);
  const audit = memoryEventSink();
  const outcome = await runUntrusted(planOf(variant.steps, [targetId]), parserFor(), runBase(), { ...portsWithoutAudit(driven.driver), audit });
  return { outcome, driven, audit };
}

for (const redTeamCase of RED_TEAM) {
  test(`run end to end, a plan that ${redTeamCase.name} ends Denied as ${redTeamCase.rule}, with no input event for the denied step`, { criterion: 'AC-SPEC-03-03' }, async () => {
    const { outcome, driven } = await runVariant(redTeamCase.harmful, redTeamCase.harmful.target ?? redTeamCase.target);
    const run = onlyRun(outcome);
    assert.equal(finalState(outcome), 'Denied', JSON.stringify(run?.steps ?? outcome));
    const rule = run === undefined ? (outcome as { readonly rule?: string }).rule : run.denial?.rule;
    assert.equal(rule, redTeamCase.rule);
    if (redTeamCase.stage === 'static') {
      assert.equal(driven.opens(), 0, 'a statically denied plan opened a browser');
      return;
    }
    assert.ok(driven.guardCalls() > 0, 'the run never asked the guard');
    assert.equal(run?.denial?.stepIndex, redTeamCase.deniedStep);
    const denied = redTeamCase.deniedStep ?? 0;
    assert.equal(driven.inputEvents[denied], 0, 'the denied step sent an input event');
    assert.deepEqual(driven.inputEvents.slice(denied).filter((count) => count > 0), [], JSON.stringify(driven.inputEvents));
  });

  test(`run end to end, the benign twin of the plan that ${redTeamCase.name} passes`, { criterion: 'AC-SPEC-03-03' }, async () => {
    const { outcome, driven, audit } = await runVariant(redTeamCase.benign, redTeamCase.benign.target ?? redTeamCase.target);
    assert.equal(finalState(outcome), 'Passed', JSON.stringify(onlyRun(outcome)?.steps ?? outcome));
    const acting = redTeamCase.benign.steps.filter((step) => step['type'] !== 'navigate').length;
    assert.equal(driven.inputEvents.reduce((total, count) => total + count, 0), acting, 'not every acting step sent its input event');
    assert.equal(audit.recorded.length, 0, JSON.stringify(audit.recorded));
  });
}

test('run end to end, the click on a test id that turns out to be Delete account is stopped by the runtime guard', { criterion: 'AC-SPEC-03-03' }, async () => {
  const runtimeClick = RED_TEAM.find((redTeamCase) => redTeamCase.actionKind === 'click' && redTeamCase.stage === 'runtime');
  assert.ok(runtimeClick !== undefined, 'the red-team set has no runtime click case');
  const { outcome, driven, audit } = await runVariant(runtimeClick.harmful, runtimeClick.target);
  const run = onlyRun(outcome);
  assert.deepEqual(run?.denial, { rule: 'irreversible-action', stepIndex: 2 });
  assert.equal(driven.inputEvents[2], 0);
  assert.deepEqual(audit.recorded.map(({ event }) => [event.kind, event.code]), [['plan.denied', 'irreversible-action']]);
});
