// A plan's standing comes from its hash: with an approval it is approved, without one it runs only
// as a proposal, which refuses the project's production origins before any driver call and never
// opens the merge gate. A plan changed by one byte loses the approval it had. A declared approval
// opens the gate exactly as a verified one does, and a run under either differs only in its label.
// A decision with no proof, or one from an MCP session or a CI token, mints no approval at all: it
// is recorded against an 'unverified' or 'agent' actor, never a person.
//
// One shape the build notes leave unnamed is assumed here: a run receives the plan's standing as
// `standing` in its inputs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunService, PERSON_ACTOR_TYPES, approvalFor, mergeGateOpen, planHash, planStanding, unverified, type Approval, type Plan, type TargetId } from '@revisum/engine';
import { baseUrlOf, clearRun, trustedProjectFrom } from '../../../support/builders/ClearRun.ts';
import { memoryApprovalStore, parsedSignupPlan, withRepository, type TestRepository } from './examples/MemoryApprovalStore.ts';
import { ORIGIN, TARGET_ID, signupPlan, testProjectInput, withValue, type JsonRecord } from '../plan/examples/GoldenPlan.ts';
import { fakeDriverNeverLaunching } from '#test-support/fakes/session/FakeDriver.ts';
import { driversOf, fakePorts } from '#test-support/fakes/FakePorts.ts';

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

// A project whose allowed origins include a production one, declared as production.
// `policy` optionally adds the project's policy, such as the allowance for approved plans on production.
const productionFields = (policy?: JsonRecord): JsonRecord =>
  ({ origins: [ORIGIN, PRODUCTION_ORIGIN], productionOrigins: [PRODUCTION_ORIGIN], ...(policy === undefined ? {} : { policy }) });

async function runPlan(plan: Plan, standing: ReturnType<typeof planStanding>, baseUrl: string, policy?: JsonRecord) {
  const driver = fakeDriverNeverLaunching();
  // Every run is one the policy gate cleared, under the plan's standing.
  const cleared = clearRun(plan, await trustedProjectFrom(testProjectInput({}, productionFields(policy))), TARGET_ID as TargetId, standing);
  const result = await createRunService(fakePorts({ drivers: driversOf(driver) })).run(cleared, {
    baseUrl: baseUrlOf(baseUrl), seed: 7, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: 'test', arch: 'test' },
  });
  return { result, driverCalls: driver.calls.count() };
}

// ---- No approval: a proposal ---------------------------------------------------------------------

test('a plan whose hash has no approval stands as a proposal, and a proposal never opens the merge gate', () => {
  const standing = planStanding(parsedSignupPlan(), memoryApprovalStore([]));
  assert.deepEqual(standing, { mode: 'proposal' });
  assert.equal(mergeGateOpen(standing), false);
});

test('approvals of other subjects leave a plan standing as a proposal', async () => {
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify(repository.subject('trusted-file'), repository.lockdownProof());
    assert.equal(verified.ok, true, JSON.stringify(verified));
    const store = memoryApprovalStore([verified.value.approval]);
    assert.equal(approvalFor(parsedSignupPlan(), store), null);
    assert.deepEqual(planStanding(parsedSignupPlan(), store), { mode: 'proposal' });
  });
});

test('with its own approval the plan stands approved and opens the merge gate', async () => {
  // The counter-example: the same plan, once its hash has an approval.
  const approval = await approvalIn('solo', declaredPlanApproval);
  const standing = planStanding(parsedSignupPlan(), memoryApprovalStore([approval]));
  assert.deepEqual(standing, { mode: 'approved', approval });
  assert.equal(mergeGateOpen(standing), true);
});

test('a proposal run on a production origin is refused with origin-not-allowed before any driver call', async () => {
  const { result, driverCalls } = await runPlan(parsedSignupPlan(), { mode: 'proposal' }, PRODUCTION_ORIGIN);
  assert.equal(driverCalls, 0, 'the driver was called for a proposal on a production origin');
  assert.equal(result.refusal?.code, 'origin-not-allowed', JSON.stringify(result));
});

test('a proposal run on a non-production origin goes ahead', async () => {
  const { driverCalls } = await runPlan(parsedSignupPlan(), { mode: 'proposal' }, ORIGIN);
  assert.ok(driverCalls > 0, 'a proposal on a non-production origin was not run');
});

test('the same plan, approved, may run on the production origin', async () => {
  // The counter-example: only the standing differs from the refused proposal above.
  const approval = await approvalIn('solo', declaredPlanApproval);
  // Production is denied to every plan unless the project allows it for approved plans.
  const { result, driverCalls } = await runPlan(parsedSignupPlan(), { mode: 'approved', approval }, PRODUCTION_ORIGIN, { allowProductionForApprovedPlans: true });
  assert.ok(driverCalls > 0, 'an approved plan was not run');
  assert.equal(result.refusal, undefined, JSON.stringify(result));
});

// ---- One byte changed ---------------------------------------------------------------------------

test('the approval still applies to the same plan parsed again from the same JSON', async () => {
  const store = memoryApprovalStore([await approvalIn('solo', declaredPlanApproval)]);
  assert.equal(planStanding(parsedSignupPlan(signupPlan()), store).mode, 'approved');
});

for (const [what, path] of [['title', ['meta', 'title']], ['criterion id of an assertion', ['steps', 1, 'criterionId']], ['filled value', ['steps', 3, 'value']]] as const) {
  test(`a plan whose ${what} changes by one byte no longer has the approval it had`, async () => {
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
  test(`a decision that arrives through ${source === 'mcp' ? 'an MCP session' : 'a CI token'} is recorded with actor type agent`, () => {
    const actor = unverified({ kind: 'plan', hash: planHash(parsedSignupPlan()) }, source);
    assert.equal(actor.actorType, 'agent');
    assert.equal(PERSON_ACTOR_TYPES.includes(actor.actorType), false);
  });
}

// ---- Local decisions with no proof --------------------------------------------------------------

test('a local decision with no proof is recorded as unverified, which is not a person', () => {
  const actor = unverified({ kind: 'review-decision', hash: planHash(parsedSignupPlan()) }, 'local');
  assert.equal(actor.actorType, 'unverified');
  assert.equal(PERSON_ACTOR_TYPES.includes(actor.actorType), false);
});

test('a plan with only unverified decisions stands as a proposal and does not open the merge gate', () => {
  const plan = parsedSignupPlan();
  for (const source of ['local', 'mcp', 'token'] as const) unverified({ kind: 'plan', hash: planHash(plan) }, source);
  const standing = planStanding(plan, memoryApprovalStore([]));
  assert.equal(mergeGateOpen(standing), false);
});

// ---- Declared counts exactly as verified --------------------------------------------------------

test('a declared and a verified approval of the same plan each open the merge gate', async () => {
  const plan = parsedSignupPlan();
  const declared = await approvalIn('solo', declaredPlanApproval);
  const verified = await approvalIn('team', verifiedPlanApproval);
  assert.deepEqual([declared.strength, verified.strength], ['declared', 'verified']);
  assert.equal(mergeGateOpen(planStanding(plan, memoryApprovalStore([declared]))), true);
  assert.equal(mergeGateOpen(planStanding(plan, memoryApprovalStore([verified]))), true);
});

test('a run under a declared approval carries the "declared, not verified" label', async () => {
  const approval = await approvalIn('solo', declaredPlanApproval);
  const { result } = await runPlan(parsedSignupPlan(), { mode: 'approved', approval }, ORIGIN);
  assert.ok(JSON.stringify(result).includes('declared, not verified'), JSON.stringify(result));
});

test('a run under a declared approval equals one under a verified approval except for its label', async () => {
  // Metamorphic: swap the approval's route and only the label (and the hashes over it) may change.
  const plan = parsedSignupPlan();
  const comparable = (result: unknown, label: string): string => {
    const { resultHash: _hash, timings: _timings, ...rest } = result as Record<string, unknown>;
    return JSON.stringify({ ...rest, evidenceHash: undefined }).replaceAll(label, '<label>');
  };
  const declared = await runPlan(plan, { mode: 'approved', approval: await approvalIn('solo', declaredPlanApproval) }, ORIGIN);
  const verified = await runPlan(plan, { mode: 'approved', approval: await approvalIn('team', verifiedPlanApproval) }, ORIGIN);
  assert.ok(JSON.stringify(declared.result).includes('declared, not verified'), 'the declared run carries no label');
  assert.equal(comparable(declared.result, 'declared, not verified'), comparable(verified.result, 'verified'));
});
