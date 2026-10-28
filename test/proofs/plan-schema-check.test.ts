// The published JSON Schema of the plan language stays true to the parser, describes every golden
// plan, and never changes without a changelog entry. The check runs in `npm run lint`; each test
// breaks one of those promises in a throw-away copy of the repository and expects the lint to
// fail, naming the file. The schema itself comes from planJsonSchema(), which builds it from the
// same tables the parser uses.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { planJsonSchema } from '@revisum/engine';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { copyRepository, type LintOutcome, type ScratchRepository } from './scratch-repository.ts';

const SCHEMA_PATH = 'docs/plan-language/plan.schema.json';
const CHANGELOG_PATH = 'docs/plan-language/CHANGELOG.md';
const GOLDEN_SIGNUP_PATH = 'golden/plans/signup.json';
const TIMEOUT = 300_000;

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

function assertFailsNaming(outcome: LintOutcome, fileName: string): void {
  assert.equal(outcome.passed, false, 'the lint passed');
  assert.ok(outcome.failureOutput.includes(fileName), `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`);
}

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');
const committedSchemaText = (): string => readFileSync(join(REPOSITORY_ROOT, SCHEMA_PATH), 'utf8');

// ---- The committed schema -----------------------------------------------------------------------

test('the committed schema is exactly what planJsonSchema() builds', { criterion: 'AC-SPEC-01-10' }, () => {
  assert.deepEqual(JSON.parse(committedSchemaText()), planJsonSchema());
});

test('planJsonSchema() is a JSON Schema 2020-12 document and builds the same bytes every time', { criterion: 'AC-SPEC-01-10' }, () => {
  const schema = planJsonSchema() as { readonly $schema?: unknown };
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(JSON.stringify(planJsonSchema()), JSON.stringify(planJsonSchema()));
});

test('the newest changelog entry names the committed schema\'s sha256', { criterion: 'AC-SPEC-01-10' }, () => {
  const changelog = readFileSync(join(REPOSITORY_ROOT, CHANGELOG_PATH), 'utf8');
  assert.ok(changelog.includes(sha256Of(committedSchemaText())), 'the schema hash is in the changelog');
});

// ---- The lint check -----------------------------------------------------------------------------

test('control: the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-01-10', timeout: TIMEOUT }, () => {
  const outcome = scratch.lint();
  assert.equal(outcome.passed, true, outcome.failureOutput);
});

test('the lint fails when the committed schema is stale', { criterion: 'AC-SPEC-01-10', timeout: TIMEOUT }, () => {
  const outcome = scratch.lintWithEdit(SCHEMA_PATH, (text) => {
    const schema: Record<string, unknown> = JSON.parse(text);
    return `${JSON.stringify({ ...schema, description: `${String(schema['description'] ?? '')} (edited by hand)` }, null, 2)}\n`;
  });
  assertFailsNaming(outcome, 'plan.schema.json');
});

test('the lint fails when a golden plan does not validate against the schema', { criterion: 'AC-SPEC-01-10', timeout: TIMEOUT }, () => {
  const plan: { steps: unknown[] } = JSON.parse(readFileSync(join(REPOSITORY_ROOT, GOLDEN_SIGNUP_PATH), 'utf8'));
  plan.steps.push({ type: 'eval', code: 'fetch("/admin")' });
  const outcome = scratch.lintWith('golden/plans/planted-invalid.json', `${JSON.stringify(plan, null, 2)}\n`);
  assertFailsNaming(outcome, 'planted-invalid.json');
});

test('the lint fails when a golden plan lacks a criterion id on an assertion', { criterion: 'AC-SPEC-01-10', timeout: TIMEOUT }, () => {
  const plan: { steps: Record<string, unknown>[] } = JSON.parse(readFileSync(join(REPOSITORY_ROOT, GOLDEN_SIGNUP_PATH), 'utf8'));
  const assertion = plan.steps.find((step) => step['type'] === 'expect');
  assert.ok(assertion);
  delete assertion['criterionId'];
  const outcome = scratch.lintWith('golden/plans/planted-untraced.json', `${JSON.stringify(plan, null, 2)}\n`);
  assertFailsNaming(outcome, 'planted-untraced.json');
});

test('the lint fails when the newest changelog entry does not name the schema\'s sha256', { criterion: 'AC-SPEC-01-10', timeout: TIMEOUT }, () => {
  const hash = sha256Of(readFileSync(join(scratch.root, SCHEMA_PATH), 'utf8'));
  const outcome = scratch.lintWithEdit(CHANGELOG_PATH, (text) => text.replaceAll(hash, '0'.repeat(64)));
  assertFailsNaming(outcome, 'CHANGELOG.md');
});

// Counter-example: another valid golden plan is accepted, so the failures above come from the
// planted problem, not from any new file in golden/plans/.
test('the lint accepts a new golden plan that validates', { criterion: 'AC-SPEC-01-10', timeout: TIMEOUT }, () => {
  const plan: { meta: Record<string, unknown> } = JSON.parse(readFileSync(join(REPOSITORY_ROOT, GOLDEN_SIGNUP_PATH), 'utf8'));
  plan.meta['title'] = 'Sign-up happy path, second copy';
  const outcome = scratch.lintWith('golden/plans/planted-valid.json', `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(outcome.passed, true, outcome.failureOutput);
});
