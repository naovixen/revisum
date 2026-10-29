// An approval belongs to one subject hash and to nothing else:
//   - the code-owner route approves only the subject whose hash matches the file at the subject's
//     path on the protected branch, as the lock-down route already does, so a review of the
//     sign-up plan cannot be offered for a plan nobody reviewed;
//   - a run, and the policy gate before it, use a plan's standing only when the approval in it is
//     for that plan's own hash. Another plan's standing leaves the plan a proposal: no production
//     origin and no approval label.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultRedactor, failure, planHash, planParser, planStanding, policyGate, run, runUntrusted, success,
  type Approval, type ApprovalErrorCode, type ApprovalSubject, type BrowserDriver, type DerivedActor, type Plan,
  type PlanStanding, type Project, type Result, type TargetId,
} from '@revisum/engine';
import { memoryArtifactStore, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../../support/policy-clearance.ts';
import {
  PLAN_PATH, eventsOfKind, memoryApprovalStore, memoryEventSink, parsedSignupPlan, withRepository, type TestRepository,
} from './approval-repositories.ts';
import { ORIGIN, TARGET_ID, signupPlan, testProject, testProjectInput, withValue, type JsonRecord } from './plan-examples.ts';

const PRODUCTION_ORIGIN = 'https://shop.example.com';
const UNREVIEWED_HASH = 'f'.repeat(64);

// The codes a refusal for a subject that is not on the protected branch may carry.
const MISMATCH_CODES: readonly ApprovalErrorCode[] = ['subject-mismatch', 'not-protected-branch'];

// The attempt is refused because the subject does not match: no plan.approved event, and an
// approval.refused event that carries the code.
function assertSubjectRefused(
  repository: TestRepository, verified: Result<{ approval: Approval; actor: DerivedActor }, ApprovalErrorCode>,
): void {
  assert.equal(verified.ok, false, `an unreviewed subject verified: ${JSON.stringify(verified)}`);
  if (verified.ok) return;
  assert.ok(MISMATCH_CODES.includes(verified.error), `expected one of ${MISMATCH_CODES.join(', ')}, got ${verified.error}`);
  assert.equal(eventsOfKind(repository.events, 'plan.approved').length, 0, 'a refused attempt left a plan.approved event');
  assert.ok(eventsOfKind(repository.events, 'approval.refused').some(({ event }) => event.code === verified.error),
    JSON.stringify(repository.events.recorded));
}

// The sign-up plan with its title changed by one character.
const retitledSignupInput = (): JsonRecord => withValue(signupPlan(), ['meta', 'title'], 'Sign-up happy patx');

// ---- The code-owner route checks the subject hash -----------------------------------------------

test('a code-owner review does not approve a plan hash that no file on the protected branch has', { criterion: 'AC-SPEC-02-05' }, async () => {
  await withRepository('team', async (repository) => {
    const subject: ApprovalSubject = { kind: 'plan', hash: UNREVIEWED_HASH, path: PLAN_PATH };
    assertSubjectRefused(repository, await repository.verify(subject, repository.codeOwnerProof('review-grace')));
  });
});

test('a code-owner review of the sign-up plan does not approve the same plan changed by one byte', { criterion: 'AC-SPEC-02-04' }, async () => {
  await withRepository('team', async (repository) => {
    const changed = parsedSignupPlan(retitledSignupInput());
    assert.notEqual(planHash(changed), repository.subject('plan').hash);
    const subject: ApprovalSubject = { kind: 'plan', hash: planHash(changed), path: PLAN_PATH };
    assertSubjectRefused(repository, await repository.verify(subject, repository.codeOwnerProof('review-grace')));
  });
});

test('the same review approves the plan whose hash matches the file on the protected branch', { criterion: 'AC-SPEC-02-05' }, async () => {
  // The counter-example: only the subject hash differs from the two refusals above.
  await withRepository('team', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace'));
    assert.equal(verified.ok, true, JSON.stringify(verified));
  });
});

// ---- A standing is for one plan's hash ----------------------------------------------------------

// A project with a production origin, open to approved plans.
const productionPolicy: JsonRecord = {
  origins: [ORIGIN, PRODUCTION_ORIGIN], productionOrigins: [PRODUCTION_ORIGIN], policy: { allowProductionForApprovedPlans: true },
};
const productionProject = (): Project => testProject({}, productionPolicy);
const parseForProduction = planParser(productionProject());

function parsedForProduction(input: JsonRecord): Plan {
  const parsed = parseForProduction(input);
  if (!parsed.ok) throw new Error(`the plan was rejected: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// The maintainer's declared approval of `plan`, with the plan on the solo repository's protected branch.
async function declaredApprovalOf(plan: Plan): Promise<Approval> {
  let approval: Approval | undefined;
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify({ kind: 'plan', hash: planHash(plan), path: PLAN_PATH }, repository.lockdownProof());
    if (!verified.ok) throw new Error(`the plan was not approved: ${verified.error}`);
    approval = verified.value.approval;
  }, (fixture) => { fixture.protectedFiles[PLAN_PATH] = plan; });
  if (approval === undefined) throw new Error('no approval');
  return approval;
}

async function standingOf(plan: Plan): Promise<PlanStanding> {
  const standing = planStanding(plan, memoryApprovalStore([await declaredApprovalOf(plan)]));
  assert.equal(standing.mode, 'approved', 'the plan did not stand approved under its own approval');
  return standing;
}

type CountingDriver = BrowserDriver & { calls: number };

function countingDriver(): CountingDriver {
  const driver: CountingDriver = {
    info: { id: 'playwright', version: 'test', protocol: 'none' },
    calls: 0,
    supports() { driver.calls += 1; return success(true as const); },
    async open() {
      driver.calls += 1;
      return failure({ reason: 'launch-failed' as const, detail: 'the counting driver opens no browser' });
    },
  };
  return driver;
}

const runPorts = (driver: BrowserDriver) => ({
  drivers: new Map([['playwright', driver]]), clock: systemClock, artifacts: memoryArtifactStore(),
  redactor: defaultRedactor(), audit: memoryEventSink(), events: memoryRunEventSink(),
});

const runBase = (standing: PlanStanding) => ({
  project: productionProject(), baseUrl: PRODUCTION_ORIGIN, seed: 7, fixedTimeMilliseconds: 0, fixtures: [],
  host: { platform: 'test', arch: 'test' }, standing,
});

test("an AI plan given another plan's approved standing does not reach the production origin", { criterion: 'AC-SPEC-02-03' }, async () => {
  const standingOfPlanA = await standingOf(parsedForProduction(signupPlan()));
  const driver = countingDriver();
  const outcome = await runUntrusted(retitledSignupInput(), parseForProduction, runBase(standingOfPlanA), runPorts(driver));
  assert.equal(driver.calls, 0, `plan B reached a driver on the production origin: ${JSON.stringify(outcome)}`);
  assert.ok(!JSON.stringify(outcome).includes('approvalLabel'), `plan B's result carries plan A's approval label: ${JSON.stringify(outcome)}`);
});

test('the same run with the plan whose approval the standing holds does reach the production origin', { criterion: 'AC-SPEC-02-03' }, async () => {
  // The counter-example: only the plan differs from the refused run above.
  const standingOfPlanA = await standingOf(parsedForProduction(signupPlan()));
  const driver = countingDriver();
  const outcome = await runUntrusted(signupPlan(), parseForProduction, runBase(standingOfPlanA), runPorts(driver));
  assert.ok(driver.calls > 0, `plan A did not reach the driver: ${JSON.stringify(outcome)}`);
  assert.ok(JSON.stringify(outcome).includes('declared, not verified'), JSON.stringify(outcome));
});

test("a cleared plan run with another plan's standing is refused the production origin before any driver call", { criterion: 'AC-SPEC-02-03' }, async () => {
  const standingOfPlanA = await standingOf(parsedForProduction(signupPlan()));
  const planB = parsedForProduction(retitledSignupInput());
  const trusted = await trustedProjectFrom(testProjectInput({}, productionPolicy));
  const driver = countingDriver();
  const result = await run({ ...runBase(standingOfPlanA), plan: authorise(planB, trusted), targetId: TARGET_ID as TargetId }, runPorts(driver));
  assert.equal(driver.calls, 0, `plan B reached a driver on the production origin: ${JSON.stringify(result)}`);
  assert.ok(JSON.stringify(result).includes('origin_not_allowed'), JSON.stringify(result));
  assert.equal(result.approvalLabel, undefined, "plan B's result carries plan A's approval label");
});

test("the policy gate denies another plan's standing the production origin a navigation names", { criterion: 'AC-SPEC-02-03' }, async () => {
  const toProduction = (input: JsonRecord): JsonRecord => withValue(input, ['steps', 0, 'url'], `${PRODUCTION_ORIGIN}/`);
  const planA = parsedForProduction(toProduction(signupPlan()));
  const planB = parsedForProduction(toProduction(retitledSignupInput()));
  const standingOfPlanA = await standingOf(planA);
  const gate = policyGate({ project: productionProject(), events: memoryEventSink() });
  const targets = productionProject().matrix;
  const forPlanB = gate.decide(planB, targets, standingOfPlanA);
  assert.deepEqual(forPlanB.kind === 'deny' ? { rule: forPlanB.rule, stepIndex: forPlanB.stepIndex } : forPlanB.kind,
    { rule: 'production-origin', stepIndex: 0 });
  // The counter-example: plan A under its own standing is allowed the same navigation.
  assert.equal(gate.decide(planA, targets, standingOfPlanA).kind, 'allow');
});
