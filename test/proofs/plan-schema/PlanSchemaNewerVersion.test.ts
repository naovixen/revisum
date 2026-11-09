// The published schema for the plan language. test/golden/plans/ holds a golden plan per feature, and
// `npm run lint` validates all of them against the schema. The newest changelog entry must name the
// committed schema's sha256, so a schema change without an entry update fails the lint. Each lint
// test breaks one promise in a throw-away copy of the repository; the general schema checks are in plan-schema-check.test.ts.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parseProject, planParser } from '@revisum/engine';
import { CURRENT_VERSION, testProjectInput } from '../../unit/engine/plan/examples/GoldenPlan.ts';
import { CHANGELOG_PATH, withoutNewestEntry } from '../../support/repository/ChangelogEntries.ts';
import { GOLDEN, REPOSITORY_ROOT } from '../../support/repository/RepositoryRoot.ts';
import { RepositoryRuleName } from '../../../tools/repo-rules/RunRepositoryRules.ts';
import { copyRepository, type LintOutcome, type ScratchRepository } from '../repo-rules/support/ScratchRepository.ts';

const TIMEOUT = 300_000;

type JsonRecord = Record<string, unknown>;

const readText = (relativePath: string): string => readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');

const goldenPlans = (): { readonly name: string; readonly plan: JsonRecord }[] =>
  readdirSync(join(GOLDEN, 'plans')).filter((name) => name.endsWith('.json')).sort()
    .map((name) => ({ name, plan: JSON.parse(readFileSync(join(GOLDEN, 'plans', name), 'utf8')) }));

const ONLY_THE_RULE = { rule: RepositoryRuleName.PlanSchema };

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

function assertFailsNaming(outcome: LintOutcome, fileName: string): void {
  assert.equal(outcome.passed, false, 'the lint passed');
  assert.ok(outcome.failureOutput.includes(fileName), `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`);
}

// ---- One golden plan per feature ------------------------------------------------------------

// Every object inside a JSON value, depth first.
const objectsIn = (value: unknown): JsonRecord[] => {
  if (Array.isArray(value)) return value.flatMap(objectsIn);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as JsonRecord;
  return [record, ...Object.values(record).flatMap(objectsIn)];
};

const FEATURES: Readonly<Record<string, (plan: JsonRecord) => boolean>> = {
  'unique text': (plan) => objectsIn(plan['values']).some((value) => value['kind'] === 'uniqueText'),
  'unique email': (plan) => objectsIn(plan['values']).some((value) => value['kind'] === 'uniqueEmail'),
  'unique number': (plan) => objectsIn(plan['values']).some((value) => value['kind'] === 'uniqueNumber'),
  'date value': (plan) => objectsIn(plan['values']).some((value) => value['kind'] === 'date'),
  'remembered value': (plan) => objectsIn(plan['steps']).some((step) => step['type'] === 'remember'),
  'path template': (plan) => objectsIn(plan['steps']).some((step) => step['type'] === 'navigate' && typeof step['url'] === 'object'),
  'plan clock': (plan) => plan['clock'] !== undefined,
  'position': (plan) => objectsIn(plan['steps']).some((object) => 'by' in object && 'position' in object),
  'test-id attribute': (plan) => objectsIn(plan['steps']).some((object) => object['by'] === 'testId' && 'attribute' in object),
  'key chord': (plan) => objectsIn(plan['steps']).some((step) => step['type'] === 'press' && Array.isArray(step['modifiers'])),
  'multi-line text': (plan) => objectsIn(plan['steps']).some((object) => Array.isArray(object['lines'])),
  'URL prefix': (plan) => objectsIn(plan['steps']).some((object) => object['kind'] === 'urlPathStartsWith'),
};

for (const [feature, uses] of Object.entries(FEATURES)) {
  test(`a golden plan uses the feature "${feature}"`, () => {
    assert.ok(goldenPlans().some(({ plan }) => uses(plan)), `no golden plan uses ${feature}`);
  });
}

test('every golden plan parses against the shared test project and keeps the current version', () => {
  const project = parseProject(testProjectInput());
  assert.ok(project.ok, JSON.stringify(project));
  const parse = planParser(project.value);
  assert.ok(goldenPlans().length >= 9, 'there is a golden plan per feature');
  for (const { name, plan } of goldenPlans()) {
    const parsed = parse(plan);
    assert.ok(parsed.ok, `${name}: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.value.version, CURRENT_VERSION, name);
  }
});

// ---- The lint check -----------------------------------------------------------------------------

const keyboardPlan = (): JsonRecord => JSON.parse(readText('test/golden/plans/keyboard-shortcuts.json'));

test('the lint fails when a golden plan puts a value reference where the schema allows only text', { timeout: TIMEOUT }, () => {
  const plan = keyboardPlan();
  const steps = plan['steps'] as JsonRecord[];
  const assertion = steps.find((step) => step['type'] === 'expect');
  assert.ok(assertion);
  assertion['criterionId'] = { valueName: 'paletteName' };
  assertFailsNaming(scratch.lintWith('test/golden/plans/planted-reference.json', `${JSON.stringify(plan, null, 2)}\n`, ONLY_THE_RULE), 'planted-reference.json');
});

test('the lint fails when a golden plan presses an unknown modifier', { timeout: TIMEOUT }, () => {
  const plan = keyboardPlan();
  const steps = plan['steps'] as JsonRecord[];
  const chord = steps.find((step) => Array.isArray(step['modifiers']));
  assert.ok(chord);
  chord['modifiers'] = ['Hyper'];
  assertFailsNaming(scratch.lintWith('test/golden/plans/planted-modifier.json', `${JSON.stringify(plan, null, 2)}\n`, ONLY_THE_RULE), 'planted-modifier.json');
});

// Counter-example: a valid copy of a golden plan passes, so the failures above come from the
// planted problems.
test('the lint accepts a new golden plan that validates', { timeout: TIMEOUT }, () => {
  const plan = keyboardPlan();
  (plan['meta'] as JsonRecord)['title'] = 'Keyboard shortcuts, second copy';
  const outcome = scratch.lintWith('test/golden/plans/planted-valid-newer.json', `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(outcome.passed, true, outcome.failureOutput);
});

// The newest entry is the one that must name the committed schema's hash, so removing it, whichever
// version it is for, leaves a changelog the lint refuses.
test('the lint fails, naming the changelog, when the newest entry is removed', { timeout: TIMEOUT }, () => {
  const outcome = scratch.lintWithEdit(CHANGELOG_PATH, withoutNewestEntry, ONLY_THE_RULE);
  assertFailsNaming(outcome, 'CHANGELOG.md');
});
