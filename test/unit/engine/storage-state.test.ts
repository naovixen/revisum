// Saved browser storage state is a secret written by a person. A plan names it in a top-level
// `storageState: { secretName }`; the secret's value is the storage-state JSON. Core resolves it
// through the SecretStore like any secret, and no cookie or token value from it reaches any output.
// Until a driver can load it into a session, every run of such a plan is refused (RunRefusals.test.ts),
// so what the manifest will record is checked on the manifest builder.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildManifest, decodeManifest, leakScanner, manifestHash, planParser, sha256, type Plan } from '@revisum/engine';
import {
  FAKE_TARGET, echoesIn, fakeSecretValue, fakeStorageState, parsedPlan, quietDriver, resolvedSecret, runWithSecrets, secretFillPlan,
  secretName, secretProject, spyDriver,
} from './secret-examples.ts';

const SAVED = 'SAVED_SESSION';
const withStorageState = (name: string) => secretFillPlan([], { storageState: { secretName: name } });

let folder: string;
before(() => { folder = mkdtempSync(join(tmpdir(), 'storage-state-')); });
after(() => { rmSync(folder, { recursive: true, force: true }); });

// ---- Parsing ------------------------------------------------------------------------------------

test('a plan naming declared storage state parses and keeps the name', () => {
  const parsed = planParser(secretProject([SAVED]))(withStorageState(SAVED));
  assert.ok(parsed.ok, `rejected: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
  assert.deepEqual(Reflect.get(parsed.value, 'storageState'), { secretName: SAVED });
});

test('a plan naming storage state the project does not declare is rejected as unknown_value', () => {
  const parsed = planParser(secretProject(['OTHER_SESSION']))(withStorageState(SAVED));
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.error.filter((error) => error.path.startsWith('$.storageState')), [{ code: 'unknown_value', path: '$.storageState.secretName' }]);
});

test('a plan holding literal storage-state JSON, as an object or as text, is rejected without echoing it', () => {
  const state = fakeStorageState();
  const parse = planParser(secretProject([SAVED]));
  for (const literal of [JSON.parse(state.json), state.json]) {
    const parsed = parse(secretFillPlan([], { storageState: literal }));
    assert.equal(parsed.ok, false, `accepted literal storage state ${typeof literal}`);
    assert.ok(parsed.error.some((error) => error.path.startsWith('$.storageState')), JSON.stringify(parsed.error));
    const errors = JSON.stringify(parsed.error);
    assert.deepEqual([...echoesIn(errors, state.cookieValue), ...echoesIn(errors, state.tokenValue)], [], 'the error echoes a value');
  }
});

// ---- Resolution and the manifest ----------------------------------------------------------------

// The manifest of a plan naming storage state with this content, as the builder writes it.
const manifestRecording = (stateJson: string) => {
  const project = secretProject([SAVED]);
  const plan: Plan = parsedPlan(project, withStorageState(SAVED));
  const target = project.matrix.find((candidate) => candidate.id === FAKE_TARGET) ?? assert.fail('no target');
  return buildManifest({
    plan, target, adapter: { id: 'fake', version: '1.0', protocol: 'none' }, browser: { name: 'fake-browser', version: '1.0' },
    seed: 7, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: 'test', arch: 'test' },
    storageState: { name: secretName(SAVED), sha256: sha256(stateJson) },
  });
};

test('the manifest records the storage state by name and sha256 only, and reads back the same', () => {
  const state = fakeStorageState();
  const manifest = manifestRecording(state.json);
  assert.deepEqual(Reflect.get(manifest, 'storageState'), { name: SAVED, sha256: sha256(state.json) });
  assert.deepEqual(decodeManifest(JSON.parse(JSON.stringify(manifest))), { ok: true, value: manifest });
  const written = JSON.stringify(manifest);
  assert.deepEqual([...echoesIn(written, state.cookieValue), ...echoesIn(written, state.tokenValue)], []);
});

test('a different storage state under the same name changes the recorded sha256 and the manifest hash', () => {
  const first = manifestRecording(fakeStorageState().json);
  const second = manifestRecording(fakeStorageState().json);
  assert.notDeepEqual(Reflect.get(first, 'storageState'), Reflect.get(second, 'storageState'));
  assert.notEqual(manifestHash(first), manifestHash(second));
});

test('storage state the store cannot resolve ends the run with secret-missing before any driver opens', async () => {
  const spy = spyDriver();
  const ran = await runWithSecrets([SAVED], withStorageState(SAVED), {}, spy);
  assert.equal(spy.opens, 0, 'no browser session was opened');
  assert.equal(ran.result.refusal?.code, 'secret-missing');
  assert.ok(JSON.stringify(ran.result.refusal).includes(SAVED));
});

test('a run whose plan names no storage state has no storageState field in its manifest', async () => {
  const ran = await runWithSecrets([SAVED], secretFillPlan([]), { [SAVED]: fakeStorageState().json }, quietDriver());
  assert.ok(ran.result.manifest !== null, 'the run reached its manifest');
  assert.equal(Object.hasOwn(ran.result.manifest, 'storageState'), false, JSON.stringify(ran.result.manifest));
});

// ---- Leak scan over planted storage-state values ------------------------------------------------

test('the leak scan finds its canary and no cookie or token value from the storage state in the outputs', async () => {
  const state = fakeStorageState();
  const ran = await runWithSecrets(
    [SAVED, 'ACCOUNT_TOKEN'], secretFillPlan(['ACCOUNT_TOKEN'], { storageState: { secretName: SAVED } }),
    { [SAVED]: state.json, ACCOUNT_TOKEN: fakeSecretValue() }, quietDriver(),
  );
  assert.equal(ran.result.refusal?.code, 'storage-state-unsupported');
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
