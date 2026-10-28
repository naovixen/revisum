// The policy gate's static check, made before a run starts. It reads navigations and the locator
// names of clicks: a valid plan is still denied when it would click a control whose name matches
// an irreversible pattern, reach a production origin or a destructive URL path, or run on a target
// whose locale has no irreversible pattern set. Containment stops invalid plans; this gate narrows
// what a valid one may do.
// See docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBranded, canonicalJson, type PlanStanding } from '@revisum/engine';
import {
  DESTRUCTIVE_PATH, ENGLISH, FRENCH, FRENCH_IN_FRANCE, GERMAN, JAPANESE, OPEN_ACCOUNT_PAGE, ORIGIN, PRODUCTION_ORIGIN,
  PROJECT_PATTERN, PROPOSAL, approvedStanding, click, decideOn, denied, navigate, parsedPlan, planOf, policyProjectInput,
  role, testGate, withPatterns, withPolicy, type JsonRecord,
} from './policy-examples.ts';

// Decides a plan of `steps` on `targets` with a gate for `projectInput`.
async function decide(steps: readonly unknown[], targets: readonly string[] = [ENGLISH], projectInput?: JsonRecord, standing?: PlanStanding) {
  const tested = await testGate(projectInput);
  const plan = parsedPlan(planOf(steps, targets), projectInput);
  return { decision: decideOn(tested, plan, standing), plan };
}

const clickOn = (name: string): readonly JsonRecord[] => [OPEN_ACCOUNT_PAGE, click(role('button', name))];

// ---- Irreversible clicks ------------------------------------------------------------------------

test('a click on a button named "Delete account" is denied as irreversible-action with its step index', { criterion: 'AC-SPEC-03-01' }, async () => {
  const { decision } = await decide(clickOn('Delete account'));
  assert.deepEqual(decision, denied('irreversible-action', 1));
});

test('the step index names the first irreversible click, wherever it sits in the plan', { criterion: 'AC-SPEC-03-01' }, async () => {
  const { decision } = await decide([
    OPEN_ACCOUNT_PAGE, click(role('button', 'Edit profile')), click(role('button', 'Save changes')),
    click(role('button', 'Delete account')), click(role('button', 'Pay now')),
  ]);
  assert.deepEqual(decision, denied('irreversible-action', 3));
});

for (const name of ['DELETE ACCOUNT', 'delete', 'Pay now', 'Send invoice', 'Revoke access']) {
  test(`the engine's English patterns match whole words in any case: a click on "${name}" is denied`, { criterion: 'AC-SPEC-03-01' }, async () => {
    const { decision } = await decide(clickOn(name));
    assert.deepEqual(decision, denied('irreversible-action', 1));
  });
}

// Counter-examples: names that only contain a pattern inside a longer word, or none at all.
for (const name of ['Deleted items', 'Payroll', 'Resend code', 'Save changes']) {
  test(`a click on "${name}" matches no whole-word pattern and is allowed`, { criterion: 'AC-SPEC-03-01' }, async () => {
    const { decision } = await decide(clickOn(name));
    assert.equal(decision.kind, 'allow', JSON.stringify(decision));
  });
}

test('the English patterns are built in: a project that adds none still denies "Delete account"', { criterion: 'AC-SPEC-03-01' }, async () => {
  const { decision } = await decide(clickOn('Delete account'), [ENGLISH], withPatterns({}));
  assert.deepEqual(decision, denied('irreversible-action', 1));
});

test('a word the project adds to its locale\'s patterns is denied: "Archive project"', { criterion: 'AC-SPEC-03-01' }, async () => {
  const { decision } = await decide(clickOn('Archive project'));
  assert.deepEqual(decision, denied('irreversible-action', 1));
});

test(`without the project's addition of "${PROJECT_PATTERN}", the same click is allowed`, { criterion: 'AC-SPEC-03-01' }, async () => {
  const { decision } = await decide(clickOn('Archive project'), [ENGLISH], withPatterns({}));
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
});

for (const name of ['Delete account', 'delete ACCOUNT']) {
  test(`a project that allows the irreversible name "Delete account" lets a click on "${name}" through`, { criterion: 'AC-SPEC-03-01' }, async () => {
    const { decision } = await decide(clickOn(name), [ENGLISH], withPolicy({ allowedIrreversibleNames: ['Delete account'] }));
    assert.equal(decision.kind, 'allow', JSON.stringify(decision));
  });
}

test('an allowed name is matched exactly: "Delete account now" is still denied', { criterion: 'AC-SPEC-03-01' }, async () => {
  const { decision } = await decide(clickOn('Delete account now'), [ENGLISH], withPolicy({ allowedIrreversibleNames: ['Delete account'] }));
  assert.deepEqual(decision, denied('irreversible-action', 1));
});

test('with the allowed name removed from the project, the same click is denied', { criterion: 'AC-SPEC-03-01' }, async () => {
  const { decision } = await decide(clickOn('Delete account'), [ENGLISH], withPolicy({ allowedIrreversibleNames: [] }));
  assert.deepEqual(decision, denied('irreversible-action', 1));
});

test('the plan an allow decision carries is the parsed plan, unchanged, and still passes run()\'s brand check', { criterion: 'AC-SPEC-03-04' }, async () => {
  const { decision, plan } = await decide(clickOn('Save changes'));
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
  if (decision.kind !== 'allow') return;
  assert.equal(canonicalJson(decision.plan), canonicalJson(plan));
  assert.doesNotThrow(() => assertBranded(decision.plan));
});

// ---- Production origins -------------------------------------------------------------------------

const TO_PRODUCTION = [OPEN_ACCOUNT_PAGE, navigate(`${PRODUCTION_ORIGIN}/orders`)];
const productionPlan = () => parsedPlan(planOf(TO_PRODUCTION));
const PRODUCTION_OPEN = withPolicy({ allowProductionForApprovedPlans: true });

test('a proposal that navigates to the origin marked production is denied as production-origin at that step', { criterion: 'AC-SPEC-03-02' }, async () => {
  const { decision } = await decide(TO_PRODUCTION);
  assert.deepEqual(decision, denied('production-origin', 1));
});

test('by default an approved plan that navigates to production is denied as production-origin too', { criterion: 'AC-SPEC-03-02' }, async () => {
  const plan = productionPlan();
  const decision = decideOn(await testGate(), plan, await approvedStanding(plan));
  assert.deepEqual(decision, denied('production-origin', 1));
});

test('when the project allows production for approved plans, an approved plan may navigate there', { criterion: 'AC-SPEC-03-02' }, async () => {
  const plan = productionPlan();
  const decision = decideOn(await testGate(PRODUCTION_OPEN), plan, await approvedStanding(plan));
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
});

test('even then, a proposal that navigates to production is denied as production-origin', { criterion: 'AC-SPEC-03-02' }, async () => {
  const tested = await testGate(PRODUCTION_OPEN);
  const plan = productionPlan();
  assert.deepEqual(decideOn(tested, plan, PROPOSAL), denied('production-origin', 1));
  assert.deepEqual(decideOn(tested, plan), denied('production-origin', 1), 'a missing standing is a proposal');
});

test('the same navigation to the allowed origin not marked production is allowed', { criterion: 'AC-SPEC-03-02' }, async () => {
  const { decision } = await decide([OPEN_ACCOUNT_PAGE, navigate(`${ORIGIN}/orders`)]);
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
});

test('the production mark comes from the trusted project: unmarked, the same origin is allowed', { criterion: 'AC-SPEC-03-02' }, async () => {
  const { decision } = await decide(TO_PRODUCTION, [ENGLISH], policyProjectInput({ productionOrigins: [] }));
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
});

// ---- Destructive URLs ---------------------------------------------------------------------------

for (const url of [DESTRUCTIVE_PATH, `${DESTRUCTIVE_PATH}/confirm`, `${ORIGIN}${DESTRUCTIVE_PATH}`]) {
  test(`a navigation to ${url}, which matches the destructive path on an allowed origin, is denied as destructive-navigation`, { criterion: 'AC-SPEC-03-08' }, async () => {
    const { decision } = await decide([OPEN_ACCOUNT_PAGE, navigate(url)]);
    assert.deepEqual(decision, denied('destructive-navigation', 1));
  });
}

// Counter-examples: a path that only starts with the same letters, and one that differs.
for (const url of ['/account/deleted', '/account/settings']) {
  test(`a navigation to ${url}, which does not continue the destructive path after a "/", is allowed`, { criterion: 'AC-SPEC-03-08' }, async () => {
    const { decision } = await decide([OPEN_ACCOUNT_PAGE, navigate(url)]);
    assert.equal(decision.kind, 'allow', JSON.stringify(decision));
  });
}

test('the destructive paths come from the trusted project: with none declared, the same navigation is allowed', { criterion: 'AC-SPEC-03-08' }, async () => {
  const { decision } = await decide([OPEN_ACCOUNT_PAGE, navigate(DESTRUCTIVE_PATH)], [ENGLISH], withPolicy({ destructiveUrlPatterns: [] }));
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
});

// ---- Locales ------------------------------------------------------------------------------------

test('on a French target, a click on "Supprimer le compte" is denied by the built-in French patterns', { criterion: 'AC-SPEC-03-11' }, async () => {
  const { decision } = await decide(clickOn('Supprimer le compte'), [FRENCH]);
  assert.deepEqual(decision, denied('irreversible-action', 1));
});

test('on an fr-FR target, which falls back to the French patterns, "Supprimer le compte" is denied', { criterion: 'AC-SPEC-03-11' }, async () => {
  const { decision } = await decide(clickOn('Supprimer le compte'), [FRENCH_IN_FRANCE]);
  assert.deepEqual(decision, denied('irreversible-action', 1));
});

test('on a French target, a click on "Modifier le profil" matches no French pattern and is allowed', { criterion: 'AC-SPEC-03-11' }, async () => {
  const { decision } = await decide(clickOn('Modifier le profil'), [FRENCH]);
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
});

test('on a de-DE target, a click on "Konto löschen" is denied by the built-in German patterns', { criterion: 'AC-SPEC-03-11' }, async () => {
  const { decision } = await decide(clickOn('Konto löschen'), [GERMAN]);
  assert.deepEqual(decision, denied('irreversible-action', 1));
});

test('a plan on a target whose locale has no pattern set is denied as no-locale-patterns, with no step index', { criterion: 'AC-SPEC-03-11' }, async () => {
  const { decision } = await decide(clickOn('Save changes'), [JAPANESE]);
  assert.deepEqual(decision, denied('no-locale-patterns', null));
});

test('one target without a pattern set is enough to deny a plan that also runs on a covered target', { criterion: 'AC-SPEC-03-11' }, async () => {
  const { decision } = await decide(clickOn('Save changes'), [ENGLISH, JAPANESE]);
  assert.deepEqual(decision, denied('no-locale-patterns', null));
});

test('the same plan on the English target alone is allowed', { criterion: 'AC-SPEC-03-11' }, async () => {
  const { decision } = await decide(clickOn('Save changes'), [ENGLISH]);
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
});

test('once the project declares a Japanese pattern set, the same plan on the Japanese target is allowed', { criterion: 'AC-SPEC-03-11' }, async () => {
  const projectInput = withPatterns({ 'en-GB': [PROJECT_PATTERN], 'ja-JP': ['削除', '支払う', '送信', '取り消す'] });
  const { decision } = await decide(clickOn('Save changes'), [JAPANESE], projectInput);
  assert.equal(decision.kind, 'allow', JSON.stringify(decision));
});
