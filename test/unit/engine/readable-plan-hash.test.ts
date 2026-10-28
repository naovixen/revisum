// A plan's hash, and so its approval, does not depend on the form or layout it was written in:
// the sign-up plan approved as JSON keeps its approval when it arrives as readable text, as text
// laid out differently, or as JSON laid out differently. Any change to a step changes the hash,
// and the approval no longer applies.
//
// The approval is the maintainer's declared approval of the sign-up plan from the solo repository
// (approval-repositories.ts), which approves the hash of the plan as the parser returns it.
// See docs/specs/SPEC-28-plan-authoring.md and docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planHash, planStanding, readPlanText, writePlanJson, writePlanText, type Approval, type ApprovalStore, type Plan } from '@revisum/engine';
import { memoryApprovalStore, parsedSignupPlan, withRepository } from './approval-repositories.ts';
import { defaultParser, signupPlan, testProject, type JsonRecord } from './plan-examples.ts';
import { STATEMENT_WORDS, joinLines, lineOf, linesOf, withLineReplaced } from './readable-plan-examples.ts';

const parsePlan = defaultParser();

async function approvedStore(): Promise<ApprovalStore> {
  let approval: Approval | undefined;
  await withRepository('solo', async (repository) => {
    const verified = await repository.verify(repository.subject('plan'), repository.lockdownProof());
    if (!verified.ok) throw new Error(`the sign-up plan was not approved: ${verified.error}`);
    approval = verified.value.approval;
  });
  if (approval === undefined) throw new Error('no approval');
  return memoryApprovalStore([approval]);
}

function fromText(text: string): Plan {
  const read = readPlanText(text, testProject().limits);
  if (!read.ok) assert.fail(`the text was refused: ${JSON.stringify(read.error)}\n${text}`);
  const parsed = parsePlan(read.value.json);
  if (!parsed.ok) assert.fail(`the read JSON was refused: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

function fromJson(json: unknown): Plan {
  const parsed = parsePlan(json);
  if (!parsed.ok) assert.fail(`the JSON was refused: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

const signupText = (): string => writePlanText(parsedSignupPlan());

const keysReversed = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(keysReversed);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value as JsonRecord).reverse().map(([key, child]) => [key, keysReversed(child)]));
  }
  return value;
};

// The sign-up plan in every form and layout that must keep its hash.
const SAME_PLAN: readonly { readonly name: string; readonly plan: () => Plan }[] = [
  { name: 'its canonical text', plan: () => fromText(signupText()) },
  { name: 'its text with blank lines between every line', plan: () => fromText(joinLines(linesOf(signupText()).flatMap((line) => [line, '']))) },
  {
    name: 'its text with statement words in lower case',
    plan: () => fromText(joinLines(linesOf(signupText()).map((line) => {
      const word = line.trimStart().split(' ')[0] ?? '';
      return STATEMENT_WORDS.includes(word) ? line.replace(word, word.toLowerCase()) : line;
    }))),
  },
  { name: 'its text with comment lines', plan: () => fromText(joinLines(['# Sign-up, as the founder approved it', ...linesOf(signupText()), '# end'])) },
  { name: 'its canonical JSON', plan: () => fromJson(JSON.parse(writePlanJson(parsedSignupPlan()))) },
  { name: 'its JSON with keys reversed and four-space indentation', plan: () => fromJson(JSON.parse(JSON.stringify(keysReversed(signupPlan()), null, 4))) },
];

for (const { name, plan } of SAME_PLAN) {
  test(`the sign-up plan read from ${name} has the hash of the plan approved as JSON`, { criterion: 'AC-SPEC-28-07' }, () => {
    assert.equal(planHash(plan()), planHash(parsedSignupPlan()));
  });

  test(`the approval of the sign-up plan still applies to it read from ${name}`, { criterion: 'AC-SPEC-28-07' }, async () => {
    const standing = planStanding(plan(), await approvedStore());
    assert.equal(standing.mode, 'approved');
  });
}

test('a plan approved through its text form is the same subject as its JSON form', { criterion: 'AC-SPEC-28-07' }, async () => {
  // Approval is keyed by the hash alone, so the store finds the one approval for either form.
  const store = await approvedStore();
  const fromJsonForm = fromJson(signupPlan());
  const fromTextForm = fromText(signupText());
  assert.equal(store.forSubject(planHash(fromTextForm)).length, 1);
  assert.deepEqual(store.forSubject(planHash(fromTextForm)), store.forSubject(planHash(fromJsonForm)));
});

// Changes to one step of the readable text, each of which makes it a different plan.
const STEP_CHANGES: readonly { readonly name: string; readonly from: string; readonly to: string }[] = [
  { name: 'a clicked control\'s name', from: 'Click button "Create account"', to: 'Click button "Create accounts"' },
  { name: 'a step\'s kind', from: 'Click checkbox "I agree to the terms"', to: 'Hover checkbox "I agree to the terms"' },
  { name: 'a check\'s expected text', from: 'Expect test id "status" has text containing "Welcome"', to: 'Expect test id "status" has text containing "Welcome!"' },
  { name: 'a check\'s kind', from: 'Expect heading "Create your account" is visible', to: 'Expect heading "Create your account" is enabled' },
  { name: 'a criterion id', from: 'Criterion: signup.welcome-shown', to: 'Criterion: signup.welcome-shown-2' },
  { name: 'the audit mode', from: 'Check accessibility as report', to: 'Check accessibility as gate' },
];

for (const { name, from, to } of STEP_CHANGES) {
  test(`changing ${name} in the text changes the hash, and the approval no longer applies`, { criterion: 'AC-SPEC-28-07' }, async () => {
    const original = signupText();
    const changed = fromText(withLineReplaced(original, lineOf(original, from), to));
    assert.notEqual(planHash(changed), planHash(parsedSignupPlan()));
    assert.deepEqual(planStanding(changed, await approvedStore()), { mode: 'proposal' });
  });
}

test('swapping two steps in the text changes the hash', { criterion: 'AC-SPEC-28-07' }, () => {
  const original = signupText();
  const first = lineOf(original, 'Click checkbox "I agree to the terms"');
  const second = lineOf(original, 'Click button "Create account"');
  const swapped = withLineReplaced(withLineReplaced(original, first, 'Click button "Create account"'), second, 'Click checkbox "I agree to the terms"');
  assert.notEqual(planHash(fromText(swapped)), planHash(parsedSignupPlan()));
});
