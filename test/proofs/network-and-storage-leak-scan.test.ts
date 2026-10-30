// Nothing a run's storage, observed response bodies or stub arguments held reaches what the run
// keeps. Runs on the own CDP driver (fixtures/network-stubs-app/account.html):
//   - start a stub whose JSON body carries a planted secret, given as the stub's secret argument;
//   - write a second planted secret to session storage with setStorage;
//   - load the profile, whose response body holds a canary e-mail address, and the stubbed token;
//   - check the page's own storage entry, which holds a canary name;
// and each then ends with one failed check: of the e-mail field, of the token field, of the
// secret storage entry and of the name storage entry. The leak scan runs over every result, event
// log, audit log and image beside a planted copy of each value: it must find each value only
// where it was planted. A failed storage check says only that the value differs.
// The control run checks the element that shows the canary name against a text it can never
// equal, so the observation does reach the result, and the scan finds it there.
// Not covered here: the visual report, which a run cannot produce until the result model joins it
// (SPEC-11, SPEC-12), and text drawn as pixels, which no text scan can read.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md and docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { leakScanner } from '@revisum/engine';
import {
  CDP_TARGET, STORAGE_SECRET, STUB_SECRET, click, expectResponse, expectStorage, navigate, networkHarness, outcomes, role, secretArgument,
  setStorage, startStub, testId, textEquals, type JsonRecord, type NetworkHarness, type NetworkRun,
} from '../contract/network-stubs-support.ts';
import { echoesIn, fakeEnvironmentStore, fakeSecretValue, resolvedSecret } from '../unit/engine/secret-examples.ts';

const TIMEOUT = 300_000;

let harness: NetworkHarness;
let folder: string;
let stubSecretValue: string;
let storageSecretValue: string;
before(async () => {
  harness = await networkHarness();
  folder = mkdtempSync(join(tmpdir(), 'network-storage-leak-scan-'));
  stubSecretValue = fakeSecretValue();
  storageSecretValue = fakeSecretValue();
});
after(async () => {
  await harness.close();
  rmSync(folder, { recursive: true, force: true });
});

const resultText = (ran: NetworkRun): string => JSON.stringify(ran.result, null, 2);
const eventLines = (ran: NetworkRun): string => ran.events.read().map((event) => JSON.stringify(event)).join('\n');
const auditLines = (ran: NetworkRun): string => ran.audit.recorded.map((recorded) => JSON.stringify(recorded)).join('\n');

// Writes the run's result, event log, audit events and images to the scan folder and returns their paths.
function writeOutputs(name: string, ran: NetworkRun): string[] {
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

// Every value that must not leak, by a name for the scan.
const plantedValues = (): readonly (readonly [string, string])[] => [
  ['STUB_ARGUMENT_SECRET', stubSecretValue],
  ['STORAGE_ARGUMENT_SECRET', storageSecretValue],
  ['PROFILE_EMAIL_CANARY', harness.canaries.profileEmail],
  ['PROFILE_NAME_CANARY', harness.canaries.profileName],
];

// Uses all three powers, with every check passing, then ends with the one failed check given.
const leakSteps = (lastCheck: JsonRecord): unknown[] => [
  navigate('/account.html'),
  startStub('accountToken', { token: secretArgument(STUB_SECRET) }),
  setStorage('sessionToken', { token: secretArgument(STORAGE_SECRET) }),
  click(role('button', 'Load profile')),
  textEquals(testId('profile-state'), 'Profile loaded', 'leaks.profile-loaded'),
  expectResponse('profile', { kind: 'fieldPresent', field: 'email' }, 'leaks.email-present'),
  expectResponse('token', { kind: 'fieldPresent', field: 'token' }, 'leaks.token-present'),
  expectStorage('sessionToken', { kind: 'present' }, 'leaks.token-stored'),
  expectStorage('profileName', { kind: 'present' }, 'leaks.name-stored'),
  { type: 'capture', name: 'profile-loaded' },
  lastCheck,
];

const FAILED_CHECKS: readonly { readonly name: string; readonly check: JsonRecord }[] = [
  { name: 'email-field', check: expectResponse('profile', { kind: 'fieldEquals', field: 'email', value: 'nobody@example.test' }, 'leaks.email-checked') },
  { name: 'token-field', check: expectResponse('token', { kind: 'fieldEquals', field: 'token', value: 'deliberately wrong' }, 'leaks.token-checked') },
  { name: 'token-storage', check: expectStorage('sessionToken', { kind: 'equals', value: 'deliberately different' }, 'leaks.token-storage-checked') },
  { name: 'name-storage', check: expectStorage('profileName', { kind: 'equals', value: 'deliberately different' }, 'leaks.name-storage-checked') },
];

test('the leak scan finds no planted secret or canary personal data in what runs with stubs, request checks and storage keep', { criterion: 'AC-SPEC-33-11', timeout: TIMEOUT }, async () => {
  const outputs: string[] = [];
  const secrets = fakeEnvironmentStore({ [STUB_SECRET]: stubSecretValue, [STORAGE_SECRET]: storageSecretValue });
  for (const { name, check } of FAILED_CHECKS) {
    const ran = await harness.runSteps(CDP_TARGET, leakSteps(check), { secrets });
    // The probe is live: every power was used and every check before the last passed.
    const all = outcomes(ran.result);
    const last = all.length - 1;
    assert.deepEqual(all.slice(0, last).filter(([, outcome]) => outcome !== 'passed'), [], `${name}: ${JSON.stringify(ran.result.steps)}`);
    assert.deepEqual(all[last], [last, 'failed', 'assertion-failed'], `${name}: the last check failed as planned`);
    assert.ok(ran.store.references().length > 0, `${name}: the run kept its capture`);

    // Checked directly, without the engine's scanner.
    for (const [label, value] of plantedValues()) {
      assert.deepEqual(echoesIn(resultText(ran), value), [], `${name}: forms of ${label} in the result`);
      assert.deepEqual(echoesIn(eventLines(ran), value), [], `${name}: forms of ${label} in the event log`);
      assert.deepEqual(echoesIn(auditLines(ran), value), [], `${name}: forms of ${label} in the audit events`);
    }
    outputs.push(...writeOutputs(name, ran));
  }

  const plantedPath = join(folder, 'planted.values.json');
  writeFileSync(plantedPath, JSON.stringify({ observed: plantedValues().map(([, value]) => `planted ${value}`) }));
  const scanned = plantedValues().map(([label, value]) => resolvedSecret(label, value));
  const leaks = leakScanner().scan([...outputs, plantedPath], scanned);
  for (const secret of scanned) {
    assert.ok(leaks.some((leak) => leak.secret === secret.name && leak.file === plantedPath), `the scan found the planted ${secret.name}`);
  }
  assert.deepEqual(leaks.filter((leak) => leak.file !== plantedPath).map((leak) => `${leak.secret} in ${leak.file}`), [], 'each value is found only where it was planted');
});

test('a failed storage check says only that the value differs', { criterion: 'AC-SPEC-33-11', timeout: TIMEOUT }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    navigate('/account.html'),
    expectStorage('profileName', { kind: 'equals', value: 'deliberately different' }, 'leaks.name-differs'),
  ]);
  const check = ran.result.steps[1];
  assert.equal(check?.outcome, 'failed');
  assert.equal(check?.code, 'assertion-failed', JSON.stringify(check));
  assert.equal(check?.observed ?? 'differs', 'differs', `the observation, if any, is only "differs": ${JSON.stringify(check)}`);
});

// Control: the canary name, observed by a failed check of the element that shows it, does reach
// the result, and the scan finds it there.
test('control: a failed check of the element showing the canary name keeps it in the result, and the scan finds it', { criterion: 'AC-SPEC-33-11', timeout: TIMEOUT }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    navigate('/account.html'),
    textEquals(testId('profile-name'), 'deliberately wrong', 'leaks.name-shown'),
  ]);
  const check = ran.result.steps[1];
  assert.equal(check?.outcome, 'failed');
  assert.ok(check?.observed?.includes(harness.canaries.profileName), `the observation should hold the canary name: ${check?.observed ?? '(none)'}`);
  const outputs = writeOutputs('control', ran);
  const leaks = leakScanner().scan(outputs, [resolvedSecret('PROFILE_NAME_CANARY', harness.canaries.profileName)]);
  assert.ok(leaks.some((leak) => leak.file.endsWith('control.result.json')), 'the scan found the canary name in the control result');
});
