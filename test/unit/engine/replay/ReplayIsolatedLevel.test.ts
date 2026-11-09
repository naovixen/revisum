// The manifest does not record a run's guarantee level, and the level is part of the result hash.
// So the level is one of a replay's inputs: an isolated run replayed without it can never pass, since
// its result then claims less than the recorded one. The replay given the level is the
// counter-example, and so is a host run, which needs none.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closedScenario, removeFakeExecutables, replayRun, replayed, runScenario, type Scenario } from './examples/ManifestUnderTest.ts';
import { OPEN_ORDERS, planOf, projectFileWith } from '../run/values/examples/RunPlan.ts';
import { GuaranteeLevel } from '@revisum/contracts';

after(removeFakeExecutables);

const NO_LEVEL: Scenario = closedScenario(projectFileWith(), planOf([OPEN_ORDERS]));
const ISOLATED: Scenario = { ...NO_LEVEL, guaranteeLevel: GuaranteeLevel.Isolated };
const HOST: Scenario = { ...NO_LEVEL, guaranteeLevel: GuaranteeLevel.Host };

test('an isolated run replayed without its level gives the verdict mismatch, never a pass', async () => {
  const ran = await runScenario(ISOLATED);
  const outcome = replayed((await replayRun(ran, { scenario: NO_LEVEL })).answer);
  assert.equal(outcome.verdict, 'mismatch');
  assert.equal(outcome.identical, false);
  assert.notEqual(outcome.resultHash, ran.result.resultHash);
});

test('an isolated run replayed at the host level gives the verdict mismatch', async () => {
  const ran = await runScenario(ISOLATED);
  const outcome = replayed((await replayRun(ran, { scenario: HOST })).answer);
  assert.equal(outcome.verdict, 'mismatch');
  assert.equal(outcome.identical, false);
});

test('the mismatch comes from the result alone, since the manifest does not record the level', async () => {
  const ran = await runScenario(ISOLATED);
  const outcome = replayed((await replayRun(ran, { scenario: NO_LEVEL })).answer);
  assert.deepEqual(outcome.differingInputs, []);
  assert.equal(outcome.manifestHash, ran.result.manifestHash);
});

test('an isolated run replayed without its level on another machine is not a pass either', async () => {
  const ran = await runScenario(ISOLATED);
  const outcome = replayed((await replayRun(ran, { scenario: NO_LEVEL, host: { platform: 'linux', arch: 'x64' } })).answer);
  assert.equal(outcome.identical, false);
  assert.notEqual(outcome.verdict, 'identical');
});

test('counter-example: an isolated run replayed with its level is identical', async () => {
  const ran = await runScenario(ISOLATED);
  const outcome = replayed((await replayRun(ran)).answer);
  assert.equal(outcome.verdict, 'identical');
  assert.equal(outcome.identical, true);
  assert.equal(outcome.resultHash, ran.result.resultHash);
});

test('a host run replayed at the isolated level gives the verdict mismatch, so a replay cannot raise a claim', async () => {
  const ran = await runScenario(HOST);
  const outcome = replayed((await replayRun(ran, { scenario: ISOLATED })).answer);
  assert.equal(outcome.verdict, 'mismatch');
  assert.equal(outcome.identical, false);
});

test('counter-example: a run given no level is identical when replayed with none, or at the host level', async () => {
  const ran = await runScenario(NO_LEVEL);
  assert.equal(replayed((await replayRun(ran)).answer).verdict, 'identical');
  assert.equal(replayed((await replayRun(ran, { scenario: HOST })).answer).verdict, 'identical');
});
