// Saved browser storage state is a secret written by a person. A plan names it in a top-level
// `storageState: { secretName }`; the secret's value is the storage-state JSON. Core resolves it
// through the SecretStore like any secret, records only its name and sha256 in the manifest, and
// no cookie or token value from it reaches any output. Loading it into a real browser session
// comes with SPEC-06, so it is not tested here.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { leakScanner, planParser, sha256 } from '@revisum/engine';
import {
  echoesIn, fakeSecretValue, fakeStorageState, manifestField, quietDriver, resolvedSecret, runWithSecrets, secretFillPlan,
  secretProject, spyDriver,
} from './secret-examples.ts';

const SAVED = 'SAVED_SESSION';
const withStorageState = (name: string) => secretFillPlan([], { storageState: { secretName: name } });

let folder: string;
before(() => { folder = mkdtempSync(join(tmpdir(), 'revisum-storage-state-')); });
after(() => { rmSync(folder, { recursive: true, force: true }); });

// ---- Parsing ------------------------------------------------------------------------------------

test('a plan naming declared storage state parses and keeps the name', { criterion: 'AC-SPEC-04-06' }, () => {
  const parsed = planParser(secretProject([SAVED]))(withStorageState(SAVED));
  assert.ok(parsed.ok, `rejected: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
  assert.deepEqual(Reflect.get(parsed.value, 'storageState'), { secretName: SAVED });
});

test('a plan naming storage state the project does not declare is rejected as unknown_value', { criterion: 'AC-SPEC-04-06' }, () => {
  const parsed = planParser(secretProject(['OTHER_SESSION']))(withStorageState(SAVED));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.deepEqual(parsed.error.filter((error) => error.path.startsWith('$.storageState')), [{ code: 'unknown_value', path: '$.storageState.secretName' }]);
});

test('a plan holding literal storage-state JSON, as an object or as text, is rejected without echoing it', { criterion: 'AC-SPEC-04-06' }, () => {
  const state = fakeStorageState();
  const parse = planParser(secretProject([SAVED]));
  for (const literal of [JSON.parse(state.json), state.json]) {
    const parsed = parse(secretFillPlan([], { storageState: literal }));
    assert.equal(parsed.ok, false, `accepted literal storage state ${typeof literal}`);
    if (parsed.ok) continue;
    assert.ok(parsed.error.some((error) => error.path.startsWith('$.storageState')), JSON.stringify(parsed.error));
    const errors = JSON.stringify(parsed.error);
    assert.deepEqual([...echoesIn(errors, state.cookieValue), ...echoesIn(errors, state.tokenValue)], [], 'the error echoes a value');
  }
});

// ---- Resolution and the manifest ----------------------------------------------------------------

test('the manifest records the storage state by name and sha256 only', { criterion: 'AC-SPEC-04-06' }, async () => {
  const state = fakeStorageState();
  const ran = await runWithSecrets([SAVED], withStorageState(SAVED), { [SAVED]: state.json }, quietDriver());
  assert.ok(ran.result.manifest, 'the run reached its manifest');
  assert.deepEqual(manifestField(ran.result, 'storageState'), { name: SAVED, sha256: sha256(state.json) });
  const manifest = JSON.stringify(ran.result.manifest);
  assert.deepEqual([...echoesIn(manifest, state.cookieValue), ...echoesIn(manifest, state.tokenValue)], []);
});

test('a different storage state under the same name changes the recorded sha256', { criterion: 'AC-SPEC-04-06' }, async () => {
  const first = await runWithSecrets([SAVED], withStorageState(SAVED), { [SAVED]: fakeStorageState().json }, quietDriver());
  const second = await runWithSecrets([SAVED], withStorageState(SAVED), { [SAVED]: fakeStorageState().json }, quietDriver());
  assert.notDeepEqual(manifestField(first.result, 'storageState'), manifestField(second.result, 'storageState'));
  assert.notEqual(first.result.manifestHash, second.result.manifestHash);
});

test('storage state the store cannot resolve ends the run with secret-missing before any driver opens', { criterion: 'AC-SPEC-04-06' }, async () => {
  const spy = spyDriver();
  const ran = await runWithSecrets([SAVED], withStorageState(SAVED), {}, spy);
  assert.equal(spy.opens, 0, 'no browser session was opened');
  assert.equal(ran.result.refusal?.code, 'secret-missing');
  assert.ok(JSON.stringify(ran.result.refusal).includes(SAVED));
});

test('a run whose plan names no storage state has no storageState field in its manifest', { criterion: 'AC-SPEC-04-06' }, async () => {
  const ran = await runWithSecrets([SAVED], secretFillPlan([]), { [SAVED]: fakeStorageState().json }, quietDriver());
  assert.ok(ran.result.manifest, 'the run reached its manifest');
  assert.equal(Object.hasOwn(ran.result.manifest, 'storageState'), false, JSON.stringify(ran.result.manifest));
});

// ---- Leak scan over planted storage-state values ------------------------------------------------

test('the leak scan finds its canary and no cookie or token value from the storage state in the outputs', { criterion: 'AC-SPEC-04-06' }, async () => {
  const state = fakeStorageState();
  const ran = await runWithSecrets(
    [SAVED, 'ACCOUNT_TOKEN'], secretFillPlan(['ACCOUNT_TOKEN'], { storageState: { secretName: SAVED } }),
    { [SAVED]: state.json, ACCOUNT_TOKEN: fakeSecretValue() }, quietDriver(),
  );
  assert.ok(ran.result.manifest, 'the run reached its manifest');
  const resultPath = join(folder, 'result.json');
  const eventsPath = join(folder, 'events.jsonl');
  const canaryPath = join(folder, 'canary.json');
  const canaryValue = fakeSecretValue();
  writeFileSync(resultPath, JSON.stringify(ran.result, null, 2));
  writeFileSync(eventsPath, ran.eventLines);
  writeFileSync(canaryPath, JSON.stringify({ observed: `planted ${canaryValue}` }));

  const cookie = resolvedSecret('PLANTED_COOKIE', state.cookieValue);
  const token = resolvedSecret('PLANTED_TOKEN', state.tokenValue);
  const whole = resolvedSecret(SAVED, state.json);
  const canary = resolvedSecret('LEAK_SCAN_CANARY', canaryValue);
  const leaks = leakScanner().scan([resultPath, eventsPath, canaryPath], [cookie, token, whole, canary]);
  assert.deepEqual(leaks.filter((leak) => leak.secret !== canary.name), [], 'storage-state values in the outputs');
  assert.ok(leaks.some((leak) => leak.secret === canary.name && leak.file.endsWith('canary.json')), 'the scan found its planted canary');
  for (const value of [state.cookieValue, state.tokenValue]) assert.deepEqual(echoesIn(ran.everything, value), []);
});
