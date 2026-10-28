// A plan's standing comes from its hash: with an approval it is approved, without one it runs only
// as a proposal, which refuses the project's production origins before any driver call and never
// opens the merge gate. A plan changed by one byte loses the approval it had. A declared approval
// opens the gate exactly as a verified one does, and a run under either differs only in its label.
// A decision with no proof, or one from an MCP session or a CI token, mints no approval at all: it
// is recorded against an 'unverified' or 'agent' actor, never a person.
//
// One shape the build notes leave unnamed is assumed here: a run receives the plan's standing as
// `standing` in its inputs.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PERSON_ACTOR_TYPES, approvalFor, defaultRedactor, failure, mergeGateOpen, planHash, planStanding, run, success, unverified,
  type Approval, type BrowserDriver, type Plan, type Project, type TargetId,
} from '@revisum/engine';
import { memoryArtifactStore, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { memoryApprovalStore, parsedSignupPlan, withRepository, type TestRepository } from './approval-repositories.ts';
import { ORIGIN, TARGET_ID, signupPlan, testProject, withValue, type JsonRecord } from './plan-examples.ts';

const PRODUCTION_ORIGIN = 'https://shop.example.com';

// The maintainer's declared approval of the sign-up plan, from the solo repository.
async function declaredPlanApproval(repository: TestRepository): Promise<Approval> {
  const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
  if (!verified.ok) throw new Error(`the plan was not approved: ${verified.error}`);
  return verified.value.approval;
}

// A code owner's verified approval of the same plan, from the team repository.
async function verifiedPlanApproval(repository: TestRepository): Promise<Approval> {
  const verified = await repository.verify(repository.subject('plan'), repository.codeOwnerProof('review-grace'));
  if (!verified.ok) throw new Error(`the plan was not approved: ${verified.error}`);
  return verified.value.approval;
}

const approvalIn = async (name: 'solo' | 'team', get: (repository: TestRepository) => Promise<Approval>): Promise<Approval> => {
  let approval: Approval | undefined;
  await withRepository(name, async (repository) => { approval = await get(repository); });
  if (approval === undefined) throw new Error('no approval');
  return approval;
};

// The text with its last character changed, so its JSON differs by exactly one byte.
const oneByteChanged = (text: string): string => `${text.slice(0, -1)}${text.endsWith('x') ? 'y' : 'x'}`;

const stringAt = (plan: JsonRecord, path: readonly (string | number)[]): string => {
  let value: unknown = plan;
  for (const segment of path) value = (value as Record<string | number, unknown>)[segment];
  if (typeof value !== 'string') throw new Error(`no text at ${path.join('.')}`);
  return value;
};

// ---- Runs with a driver that counts calls and opens no browser -----------------------------------

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

// A project whose allowed origins include a production one, declared as production.
const projectWithProduction = (): Project =>
  testProject({}, { origins: [ORIGIN, PRODUCTION_ORIGIN], productionOrigins: [PRODUCTION_ORIGIN] });

async function runPlan(plan: Plan, standing: ReturnType<typeof planStanding>, baseUrl: string) {
  const driver = countingDriver();
  const result = await run({
    plan, project: projectWithProduction(), targetId: TARGET_ID as TargetId, baseUrl, seed: 7, fixedTimeMilliseconds: 0,
    fixtures: [], host: { platform: 'test', arch: 'test' }, standing,
  }, {
    drivers: new Map([['playwright', driver]]), clock: systemClock, artifacts: memoryArtifactStore(),
    redactor: defaultRedactor(), events: memoryRunEventSink(),
  });
  return { result, driverCalls: driver.calls };
}

// ---- No approval: a proposal ---------------------------------------------------------------------

test('a plan whose hash has no approval stands as a proposal, and a proposal never opens the merge gate', { criterion: 'AC-SPEC-02-03' }, () => {
  const standing = planStanding(parsedSignupPlan(), memoryApprovalStore([]));
  assert.deepEqual(standing, { mode: 'proposal' });
  assert.equal(mergeGateOpen(standing), false);
});

test('approvals of other subjects leave a plan standing as a proposal', { criterion: 'AC-SPEC-02-03' }, async () => {
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify(repository.subject('trusted-file'), repository.lockdownProof());
    assert.equal(verified.ok, true, JSON.stringify(verified));
    if (!verified.ok) return;
    const store = memoryApprovalStore([verified.value.approval]);
    assert.equal(approvalFor(parsedSignupPlan(), store), null);
    assert.deepEqual(planStanding(parsedSignupPlan(), store), { mode: 'proposal' });
  });
});

test('with its own approval the plan stands approved and opens the merge gate', { criterion: 'AC-SPEC-02-03' }, async () => {
  // The counter-example: the same plan, once its hash has an approval.
  const approval = await approvalIn('solo', declaredPlanApproval);
  const standing = planStanding(parsedSignupPlan(), memoryApprovalStore([approval]));
  assert.deepEqual(standing, { mode: 'approved', approval });
  assert.equal(mergeGateOpen(standing), true);
});

test('a proposal run on a production origin is refused with origin_not_allowed before any driver call', { criterion: 'AC-SPEC-02-03' }, async () => {
  const { result, driverCalls } = await runPlan(parsedSignupPlan(), { mode: 'proposal' }, PRODUCTION_ORIGIN);
  assert.equal(driverCalls, 0, 'the driver was called for a proposal on a production origin');
  assert.ok(JSON.stringify(result).includes('origin_not_allowed'), JSON.stringify(result));
});

test('a proposal run on a non-production origin goes ahead', { criterion: 'AC-SPEC-02-03' }, async () => {
  const { driverCalls } = await runPlan(parsedSignupPlan(), { mode: 'proposal' }, ORIGIN);
  assert.ok(driverCalls > 0, 'a proposal on a non-production origin was not run');
});

test('the same plan, approved, may run on the production origin', { criterion: 'AC-SPEC-02-03' }, async () => {
  // The counter-example: only the standing differs from the refused proposal above.
  const approval = await approvalIn('solo', declaredPlanApproval);
  const { result, driverCalls } = await runPlan(parsedSignupPlan(), { mode: 'approved', approval }, PRODUCTION_ORIGIN);
  assert.ok(driverCalls > 0, 'an approved plan was not run');
  assert.ok(!JSON.stringify(result).includes('origin_not_allowed'), JSON.stringify(result));
});

// ---- One byte changed ---------------------------------------------------------------------------

test('the approval still applies to the same plan parsed again from the same JSON', { criterion: 'AC-SPEC-02-04' }, async () => {
  const store = memoryApprovalStore([await approvalIn('solo', declaredPlanApproval)]);
  assert.equal(planStanding(parsedSignupPlan(signupPlan()), store).mode, 'approved');
});

for (const [what, path] of [['title', ['meta', 'title']], ['criterion id of an assertion', ['steps', 1, 'criterionId']], ['filled value', ['steps', 3, 'value']]] as const) {
  test(`a plan whose ${what} changes by one byte no longer has the approval it had`, { criterion: 'AC-SPEC-02-04' }, async () => {
    const store = memoryApprovalStore([await approvalIn('solo', declaredPlanApproval)]);
    const original = signupPlan();
    const changed = parsedSignupPlan(withValue(original, path, oneByteChanged(stringAt(original, path))));
    assert.equal(JSON.stringify(changed).length, JSON.stringify(parsedSignupPlan()).length, 'the change is not one byte');
    assert.notEqual(planHash(changed), planHash(parsedSignupPlan()));
    assert.equal(approvalFor(changed, store), null);
    assert.deepEqual(planStanding(changed, store), { mode: 'proposal' });
  });
}

// ---- MCP sessions and CI tokens -----------------------------------------------------------------

for (const source of ['mcp', 'token'] as const) {
  test(`a decision that arrives through ${source === 'mcp' ? 'an MCP session' : 'a CI token'} is recorded with actor type agent`, { criterion: 'AC-SPEC-02-07' }, () => {
    const actor = unverified({ kind: 'plan', hash: planHash(parsedSignupPlan()) }, source);
    assert.equal(actor.actorType, 'agent');
    assert.equal(PERSON_ACTOR_TYPES.includes(actor.actorType), false);
  });
}

// ---- Local decisions with no proof --------------------------------------------------------------

test('a local decision with no proof is recorded as unverified, which is not a person', { criterion: 'AC-SPEC-02-11' }, () => {
  const actor = unverified({ kind: 'review-decision', hash: planHash(parsedSignupPlan()) }, 'local');
  assert.equal(actor.actorType, 'unverified');
  assert.equal(PERSON_ACTOR_TYPES.includes(actor.actorType), false);
});

test('a plan with only unverified decisions stands as a proposal and does not open the merge gate', { criterion: 'AC-SPEC-02-11' }, () => {
  const plan = parsedSignupPlan();
  for (const source of ['local', 'mcp', 'token'] as const) unverified({ kind: 'plan', hash: planHash(plan) }, source);
  const standing = planStanding(plan, memoryApprovalStore([]));
  assert.equal(mergeGateOpen(standing), false);
});

// ---- Declared counts exactly as verified --------------------------------------------------------

test('a declared and a verified approval of the same plan each open the merge gate', { criterion: 'AC-SPEC-02-18' }, async () => {
  const plan = parsedSignupPlan();
  const declared = await approvalIn('solo', declaredPlanApproval);
  const verified = await approvalIn('team', verifiedPlanApproval);
  assert.deepEqual([declared.strength, verified.strength], ['declared', 'verified']);
  assert.equal(mergeGateOpen(planStanding(plan, memoryApprovalStore([declared]))), true);
  assert.equal(mergeGateOpen(planStanding(plan, memoryApprovalStore([verified]))), true);
});

test('a run under a declared approval carries the "declared, not verified" label', { criterion: 'AC-SPEC-02-16' }, async () => {
  const approval = await approvalIn('solo', declaredPlanApproval);
  const { result } = await runPlan(parsedSignupPlan(), { mode: 'approved', approval }, ORIGIN);
  assert.ok(JSON.stringify(result).includes('declared, not verified'), JSON.stringify(result));
});

test('a run under a declared approval equals one under a verified approval except for its label', { criterion: 'AC-SPEC-02-18' }, async () => {
  // Metamorphic: swap the approval's route and only the label (and the hash over it) may change.
  const plan = parsedSignupPlan();
  const comparable = (result: unknown, label: string): string => {
    const { resultHash: _hash, timings: _timings, ...rest } = result as Record<string, unknown>;
    return JSON.stringify(rest).replaceAll(label, '<label>');
  };
  const declared = await runPlan(plan, { mode: 'approved', approval: await approvalIn('solo', declaredPlanApproval) }, ORIGIN);
  const verified = await runPlan(plan, { mode: 'approved', approval: await approvalIn('team', verifiedPlanApproval) }, ORIGIN);
  assert.ok(JSON.stringify(declared.result).includes('declared, not verified'), 'the declared run carries no label');
  assert.equal(comparable(declared.result, 'declared, not verified'), comparable(verified.result, 'verified'));
});
