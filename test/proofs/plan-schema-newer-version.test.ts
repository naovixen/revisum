// The published schema for plan language 1.2. golden/plans/ holds every 1.1 golden plan and one
// 1.2 golden plan per feature, and `npm run lint` validates all of them against the schema. The
// changelog's newest entry is "1.2" and names the schema's sha256, so a schema change without an
// entry update fails the lint. Each lint test breaks one promise in a throw-away copy of the
// repository; the general schema checks are in plan-schema-check.test.ts.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parseProject, planParser } from '@revisum/engine';
import { GOLDEN, REPOSITORY_ROOT } from '../support/repository.ts';
import { copyRepository, type LintOutcome, type ScratchRepository } from './scratch-repository.ts';

const SCHEMA_PATH = 'docs/plan-language/plan.schema.json';
const CHANGELOG_PATH = 'docs/plan-language/CHANGELOG.md';
const TIMEOUT = 300_000;

type JsonRecord = Record<string, unknown>;

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');
const readText = (relativePath: string): string => readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');

const goldenPlans = (): { readonly name: string; readonly plan: JsonRecord }[] =>
  readdirSync(join(GOLDEN, 'plans')).filter((name) => name.endsWith('.json')).sort()
    .map((name) => ({ name, plan: JSON.parse(readFileSync(join(GOLDEN, 'plans', name), 'utf8')) }));
const newerGoldenPlans = () => goldenPlans().filter(({ plan }) => plan['version'] === '1.2');

// The sections of the changelog, each from its "## " heading to the next.
const changelogEntries = (changelog: string): string[] =>
  changelog.split(/\r?\n(?=## )/).filter((section) => section.startsWith('## '));

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

function assertFailsNaming(outcome: LintOutcome, fileName: string): void {
  assert.equal(outcome.passed, false, 'the lint passed');
  assert.ok(outcome.failureOutput.includes(fileName), `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`);
}

// ---- The changelog entry ------------------------------------------------------------------------

test('the newest changelog entry is for version 1.2 and names the committed schema\'s sha256', { criterion: 'AC-SPEC-30-02' }, () => {
  const entries = changelogEntries(readText(CHANGELOG_PATH));
  const newest = entries[0];
  assert.ok(newest !== undefined, 'the changelog has entries');
  assert.match(newest.split(/\r?\n/)[0] ?? '', /^## 1\.2 \((unreleased|\d{4}-\d{2}-\d{2})/);
  assert.ok(newest.includes(sha256Of(readText(SCHEMA_PATH))), 'the 1.2 entry names the schema hash');
  assert.equal(entries.filter((entry) => /^## 1\.2\b/.test(entry)).length, 1, 'there is one 1.2 entry');
});

// ---- One 1.2 golden plan per feature ------------------------------------------------------------

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
  test(`a 1.2 golden plan uses the feature "${feature}"`, { criterion: 'AC-SPEC-30-02' }, () => {
    assert.ok(newerGoldenPlans().some(({ plan }) => uses(plan)), `no golden plan declaring 1.2 uses ${feature}`);
  });
}

test('the 1.1 golden plans are all still in golden/plans/', { criterion: 'AC-SPEC-30-02' }, () => {
  const previous = goldenPlans().filter(({ plan }) => plan['version'] === '1.1').map(({ name }) => name);
  assert.deepEqual(previous, ['account-closure.json', 'consent.json', 'environment.json', 'signup.json']);
});

test('every 1.2 golden plan parses against the shared test project and keeps "1.2"', { criterion: 'AC-SPEC-30-02' }, () => {
  const project = parseProject({
    origins: ['http://127.0.0.1:4173'], limits: { stepTimeoutMilliseconds: 2000 },
    matrix: [{
      id: 'playwright-chromium', adapter: 'playwright', engine: 'chromium', device: 'desktop-1280',
      locale: 'de-DE', timezone: 'Asia/Tokyo', colorScheme: 'dark', reducedMotion: 'reduce',
    }],
  });
  assert.ok(project.ok, JSON.stringify(project));
  const parse = planParser(project.value);
  assert.ok(newerGoldenPlans().length >= 9, 'there is a 1.2 golden plan per feature');
  for (const { name, plan } of newerGoldenPlans()) {
    const parsed = parse(plan);
    assert.ok(parsed.ok, `${name}: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.value.version, '1.2', name);
  }
});

// ---- The lint check -----------------------------------------------------------------------------

const keyboardPlan = (): JsonRecord => JSON.parse(readText('golden/plans/keyboard-shortcuts.json'));

test('the lint fails when a 1.2 golden plan puts a value reference where the schema allows only text', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const plan = keyboardPlan();
  const steps = plan['steps'] as JsonRecord[];
  const assertion = steps.find((step) => step['type'] === 'expect');
  assert.ok(assertion);
  assertion['criterionId'] = { valueName: 'paletteName' };
  assertFailsNaming(scratch.lintWith('golden/plans/planted-reference.json', `${JSON.stringify(plan, null, 2)}\n`), 'planted-reference.json');
});

test('the lint fails when a 1.2 golden plan presses an unknown modifier', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const plan = keyboardPlan();
  const steps = plan['steps'] as JsonRecord[];
  const chord = steps.find((step) => Array.isArray(step['modifiers']));
  assert.ok(chord);
  chord['modifiers'] = ['Hyper'];
  assertFailsNaming(scratch.lintWith('golden/plans/planted-modifier.json', `${JSON.stringify(plan, null, 2)}\n`), 'planted-modifier.json');
});

// Counter-example: a valid copy of a 1.2 golden plan passes, so the failures above come from the
// planted problems.
test('the lint accepts a new 1.2 golden plan that validates', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const plan = keyboardPlan();
  (plan['meta'] as JsonRecord)['title'] = 'Keyboard shortcuts, second copy';
  const outcome = scratch.lintWith('golden/plans/planted-valid-newer.json', `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(outcome.passed, true, outcome.failureOutput);
});

test('the lint fails, naming the changelog, when the 1.2 entry is removed', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const outcome = scratch.lintWithEdit(CHANGELOG_PATH, (text) =>
    text.split(/\r?\n(?=## )/).filter((section) => !/^## 1\.2\b/.test(section)).join('\n'));
  assertFailsNaming(outcome, 'CHANGELOG.md');
});
