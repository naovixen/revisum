// Saved browser storage state is loaded into the session only once the CDP driver can do it
// (SPEC-06's SessionEnvironment). Until then a plan that names storage state must not run as if it
// had been loaded: a test that relies on being signed in could otherwise pass, or act, without the
// state it declared. Like every other feature no driver performs yet, the run fails with
// unsupported-step before any action reaches the driver. The manifest still records the storage
// state the plan declared, by name and hash, as a record of its inputs. The counter-example runs
// the same plan without storage state and passes.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordingDriver } from './run-value-examples.ts';
import { fakeStorageState, runWithSecrets, secretFillPlan } from './secret-examples.ts';

const SAVED = 'SAVED';

test('a plan naming saved storage state fails with unsupported-step before any driver action', { criterion: 'AC-SPEC-04-06' }, async () => {
  const { driver, recording } = recordingDriver();
  const ran = await runWithSecrets([SAVED], secretFillPlan([], { storageState: { secretName: SAVED } }), { [SAVED]: fakeStorageState().json }, driver);
  assert.notEqual(ran.result.state, 'Passed', 'the run passed without loading the storage state it names');
  assert.equal(ran.result.state, 'Failed', JSON.stringify(ran.result.steps));
  assert.ok(ran.result.steps.some((step) => step.code === 'unsupported-step'), `no step failed with unsupported-step: ${JSON.stringify(ran.result.steps)}`);
  assert.ok(ran.result.steps.every((step) => step.outcome !== 'passed'), `a step ran: ${JSON.stringify(ran.result.steps)}`);
  assert.deepEqual(recording.navigations, [], 'a navigation reached the driver');
  assert.deepEqual(recording.actions, [], 'an action reached the driver');
  assert.equal(recording.probes, 0, 'a check reached the driver');
});

test('counter-example: the same plan without storage state reaches the driver and passes', { criterion: 'AC-SPEC-04-06' }, async () => {
  const { driver, recording } = recordingDriver();
  const ran = await runWithSecrets([SAVED], secretFillPlan([]), { [SAVED]: fakeStorageState().json }, driver);
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  assert.equal(recording.navigations.length, 1);
  assert.ok(recording.probes > 0);
});
