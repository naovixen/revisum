// Turning evidence mode on changes nothing on the safe path. A project that declares a suite
// parses every golden plan to exactly what it gave before, the stored 1.1 parse results included,
// and runs a plan to the same result hash, manifest hash and guarantee statement as the same
// project without evidence mode.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, planParser } from '@revisum/engine';
import { GOLDEN } from '../../support/repository.ts';
import { parsedProject, projectFileWithEvidence } from './evidence-examples.ts';
import { goldenPlan, goldenPlanNames } from './plan-examples.ts';
import { OPEN_ORDERS, planOf, projectFileWith, runPlan, type JsonRecord } from './run-value-examples.ts';

const PARSED_FOLDER = join(GOLDEN, 'parsed-plans');
const storedNames = (): string[] =>
  readdirSync(PARSED_FOLDER).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).sort();

const withoutEvidence = planParser(parsedProject(projectFileWith()));
const withEvidence = planParser(parsedProject(projectFileWithEvidence()));

test('the stored 1.1 parse results are still there to compare against', { criterion: 'AC-SPEC-35-21' }, () => {
  assert.ok(storedNames().length >= 4, `only ${storedNames().length} stored parse results`);
});

for (const name of storedNames()) {
  test(`with evidence mode on, the golden plan "${name}" parses to exactly its stored result`, { criterion: 'AC-SPEC-35-21' }, () => {
    const parsed = withEvidence(goldenPlan(name));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.value)), JSON.parse(readFileSync(join(PARSED_FOLDER, `${name}.json`), 'utf8')));
  });
}

test('every golden plan parses to the same plan, byte for byte, with evidence mode on or off', { criterion: 'AC-SPEC-35-21' }, () => {
  const names = goldenPlanNames();
  assert.ok(names.length >= 20, 'the golden plans are still there');
  for (const name of names) {
    const off = withoutEvidence(goldenPlan(name));
    const on = withEvidence(goldenPlan(name));
    assert.ok(off.ok && on.ok, `${name}: ${JSON.stringify({ off, on })}`);
    assert.equal(canonicalJson(on.value), canonicalJson(off.value), name);
  }
});

// What the hashes and statement of a plan run are, for a project file.
async function planRunUnder(plan: JsonRecord, projectFile: JsonRecord) {
  const { result } = await runPlan(plan, { projectFile });
  return {
    state: result.state, mode: result.mode, resultHash: result.resultHash, manifestHash: result.manifestHash,
    guarantees: canonicalJson(result.guarantees),
  };
}

const RUN_PLANS: readonly { readonly name: string; readonly plan: () => JsonRecord }[] = [
  { name: 'a plan that opens a page and checks it', plan: () => planOf([OPEN_ORDERS]) },
  { name: 'the golden sign-up plan', plan: () => goldenPlan('signup') },
  { name: 'the golden account-closure plan', plan: () => goldenPlan('account-closure') },
];

for (const runCase of RUN_PLANS) {
  test(`${runCase.name} runs to the same result hash, manifest hash and guarantees with evidence mode on or off`, { criterion: 'AC-SPEC-35-21' }, async () => {
    const off = await planRunUnder(runCase.plan(), projectFileWith());
    const on = await planRunUnder(runCase.plan(), projectFileWithEvidence());
    assert.equal(off.mode, 'plan');
    assert.deepEqual(on, off);
  });
}

test('a plan run\'s result hash does change with a change that matters, so the comparison above can fail', { criterion: 'AC-SPEC-35-21' }, async () => {
  // The counter-example: another seed gives another run, so equal hashes above mean equal runs.
  const { result: first } = await runPlan(planOf([OPEN_ORDERS]), { seed: 7 });
  const { result: second } = await runPlan(planOf([OPEN_ORDERS]), { seed: 8 });
  assert.notEqual(first.manifestHash, second.manifestHash);
});
