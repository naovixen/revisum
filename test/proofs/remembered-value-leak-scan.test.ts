// A remembered value never reaches what a run keeps. A run on the own CDP driver remembers canary
// text from the fixture page (fixtures/plan-values-app/remember.html), types it into a field and
// checks it twice, so the value was read and used. The leak scan then runs over the run's result,
// its event log, its audit events and its images, beside a planted copy of the canary: it must
// find the canary only where it was planted. The result and the event log name the value and its
// sha256 instead.
// The control run checks the canary element against a text it can never equal, without
// remembering it, and that observation does reach the result, so the scan can see the canary when
// it is there.
// Not covered here: the visual report, which a run cannot produce until the result model joins it
// (SPEC-11, SPEC-12), and text drawn as pixels, which no text scan can read.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md and docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { leakScanner, sha256 } from '@revisum/engine';
import {
  CDP_TARGET, fill, label, navigate, planValuesHarness, reference, remember, testId, textEquals, valueEquals,
  type PlanRun, type PlanValuesHarness,
} from '../contract/plan-values-support.ts';
import { echoesIn, resolvedSecret } from '../unit/engine/secret-examples.ts';

// The canary text the fixture page shows, exactly as remember.html holds it.
const CANARY = 'CanaryQwXpLmZrTkVbNsHd';
const VALUE_NAME = 'accountReference';
const TIMEOUT = 120_000;

let harness: PlanValuesHarness;
let folder: string;
before(async () => {
  harness = await planValuesHarness();
  folder = mkdtempSync(join(tmpdir(), 'remembered-leak-scan-'));
});
after(async () => {
  await harness.close();
  rmSync(folder, { recursive: true, force: true });
});

const resultText = (ran: PlanRun): string => JSON.stringify(ran.result, null, 2);
const eventLines = (ran: PlanRun): string => ran.events.read().map((event) => JSON.stringify(event)).join('\n');
const auditLines = (ran: PlanRun): string => ran.audit.recorded.map((recorded) => JSON.stringify(recorded)).join('\n');

// Writes the run's result, event log, audit events and images to the scan folder and returns their paths.
function writeOutputs(name: string, ran: PlanRun): string[] {
  const paths = [join(folder, `${name}.result.json`), join(folder, `${name}.events.jsonl`), join(folder, `${name}.audit.jsonl`)];
  writeFileSync(paths[0] ?? '', resultText(ran));
  writeFileSync(paths[1] ?? '', eventLines(ran));
  writeFileSync(paths[2] ?? '', auditLines(ran));
  for (const artifact of ran.store.references()) {
    const bytes = ran.store.get(artifact.name);
    if (bytes === undefined) continue;
    const path = join(folder, `${name}.artifact-${paths.length}.bin`);
    writeFileSync(path, bytes);
    paths.push(path);
  }
  return paths;
}

test('the leak scan finds a remembered canary only where it was planted; the run keeps its name and sha256', { criterion: 'AC-SPEC-30-10', timeout: TIMEOUT }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    navigate('/remember.html'),
    remember(VALUE_NAME, testId('canary')),
    fill(label('Search'), reference(VALUE_NAME)),
    valueEquals(label('Search'), reference(VALUE_NAME), 'remember.canary-typed'),
    textEquals(testId('canary'), reference(VALUE_NAME), 'remember.canary-shown'),
    { type: 'capture', name: 'canary-remembered' },
  ]);
  // The probe is live: the canary was remembered, typed and checked.
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.ok(ran.store.references().length > 0, 'the run kept its capture');

  // Checked directly, without the engine's scanner.
  assert.deepEqual(echoesIn(resultText(ran), CANARY), [], 'forms of the canary in the result');
  assert.deepEqual(echoesIn(eventLines(ran), CANARY), [], 'forms of the canary in the event log');
  assert.deepEqual(echoesIn(auditLines(ran), CANARY), [], 'forms of the canary in the audit events');

  // What the run keeps instead: the value's name and its sha256.
  const digest = sha256(CANARY);
  assert.ok(resultText(ran).includes(VALUE_NAME), 'the result names the remembered value');
  assert.ok(resultText(ran).includes(digest), 'the result holds the remembered value\'s sha256');
  assert.ok(eventLines(ran).includes(digest), 'the event log holds the remembered value\'s sha256');

  const outputs = writeOutputs('remembered', ran);
  const plantedPath = join(folder, 'planted.canary.json');
  writeFileSync(plantedPath, JSON.stringify({ observed: `planted ${CANARY}` }));
  const canary = resolvedSecret('REMEMBERED_CANARY', CANARY);
  const leaks = leakScanner().scan([...outputs, plantedPath], [canary]);
  assert.ok(leaks.length > 0, 'the scan found its planted canary');
  assert.deepEqual(leaks.filter((leak) => leak.file !== plantedPath).map((leak) => leak.file), [], 'the canary is found only where it was planted');
});

// Control: the same page's canary, observed by a failed check without being remembered, does
// reach the result, and the scan finds it there.
test('control: a failed check of the canary element keeps it in the result, and the scan finds it', { criterion: 'AC-SPEC-30-10', timeout: TIMEOUT }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    navigate('/remember.html'),
    textEquals(testId('canary'), 'deliberately wrong', 'remember.canary-checked'),
  ]);
  const check = ran.result.steps[1];
  assert.equal(check?.outcome, 'failed');
  assert.ok(check?.observed?.includes(CANARY), `the observation should hold the canary: ${check?.observed ?? '(none)'}`);
  const outputs = writeOutputs('control', ran);
  const leaks = leakScanner().scan(outputs, [resolvedSecret('REMEMBERED_CANARY', CANARY)]);
  assert.ok(leaks.some((leak) => leak.file.endsWith('control.result.json')), 'the scan found the canary in the control result');
});
