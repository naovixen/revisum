// Secrets are resolved through the SecretStore when a run starts:
//   - a secret the store cannot resolve, or any secret when the run has no store, ends the run
//     before any driver opens, refused with secret-missing, naming the secret and no value;
//   - a declared secret shorter than MINIMUM_SECRET_LENGTH is redacted by key, and the manifest's
//     `secrets` field records each secret's name and redaction mode ('value' or 'key-only'). A run
//     whose plan uses no secret has no `secrets` field, so its manifest is unchanged.
// The drivers here need no browser: one never opens, one accepts every action.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINIMUM_SECRET_LENGTH, type RunResult } from '@revisum/engine';
import {
  echoesIn, fakeEnvironmentStore, fakeSecretOfLength, fakeSecretValue, manifestField, quietDriver, runWithSecrets,
  secretFillPlan, secretName, spyDriver,
} from './secret-examples.ts';

// ---- secret-missing -----------------------------------------------------------------------------

test('the environment store resolves a name that has a variable and gives null for one that has none', () => {
  const store = fakeEnvironmentStore({ ACCOUNT_TOKEN: fakeSecretValue() });
  assert.notEqual(store.resolve(secretName('ACCOUNT_TOKEN')), null);
  assert.equal(store.resolve(secretName('MISSING_TOKEN')), null);
});

test('a plan naming a secret the store cannot resolve ends with secret-missing before any driver opens', async () => {
  const resolvableValue = fakeSecretValue();
  const spy = spyDriver();
  const ran = await runWithSecrets(
    ['ACCOUNT_TOKEN', 'MISSING_TOKEN'], secretFillPlan(['ACCOUNT_TOKEN', 'MISSING_TOKEN']), { ACCOUNT_TOKEN: resolvableValue }, spy,
  );
  assert.equal(spy.calls.count('open'), 0, 'no browser session was opened');
  assert.equal(ran.artifactsStored, 0, 'no artefact was stored');
  assert.equal(ran.result.state, 'Refused');
  assert.equal(ran.result.refusal?.code, 'secret-missing');
  assert.deepEqual(ran.result.steps, [], 'no step ran');
  assert.ok(JSON.stringify(ran.result.refusal).includes('MISSING_TOKEN'), `the refusal names the secret: ${JSON.stringify(ran.result.refusal)}`);
  assert.deepEqual(echoesIn(ran.everything, resolvableValue), [], 'no form of the resolvable secret appears in the result or the log');
});

test('a missing secret named only inside a frame step still ends the run before any driver opens', async () => {
  const spy = spyDriver();
  const plan = {
    ...secretFillPlan([]),
    steps: [
      { type: 'navigate', url: '/' },
      { type: 'frame', locator: { by: 'testId', testId: 'payment-frame' }, steps: [
        { type: 'fill', locator: { by: 'label', label: 'Card token' }, value: { secretName: 'MISSING_TOKEN' } },
      ] },
      { type: 'expect', locator: { by: 'testId', testId: 'status' }, assert: { kind: 'visible' }, criterionId: 'secrets.status-shown' },
    ],
  };
  const ran = await runWithSecrets(['MISSING_TOKEN'], plan, {}, spy);
  assert.equal(spy.calls.count('open'), 0, 'no browser session was opened');
  assert.equal(ran.result.refusal?.code, 'secret-missing');
  assert.ok(JSON.stringify(ran.result.refusal).includes('MISSING_TOKEN'));
});

test('a run with no secret store refuses every secret reference with secret-missing', async () => {
  const spy = spyDriver();
  const ran = await runWithSecrets(['ACCOUNT_TOKEN'], secretFillPlan(['ACCOUNT_TOKEN']), null, spy);
  assert.equal(spy.calls.count('open'), 0, 'no browser session was opened');
  assert.equal(ran.result.state, 'Refused');
  assert.equal(ran.result.refusal?.code, 'secret-missing');
  assert.ok(JSON.stringify(ran.result.refusal).includes('ACCOUNT_TOKEN'));
});

test('control: a plan with no secret reference runs without a secret store', async () => {
  const spy = spyDriver();
  const ran = await runWithSecrets([], secretFillPlan([]), null, spy);
  assert.equal(spy.calls.count('open'), 1, 'the run reached the driver');
  assert.notEqual(ran.result.refusal?.code, 'secret-missing');
});

test('control: when the store resolves every named secret, the run goes on to open the driver', async () => {
  const spy = spyDriver();
  const ran = await runWithSecrets(
    ['ACCOUNT_TOKEN', 'MISSING_TOKEN'], secretFillPlan(['ACCOUNT_TOKEN', 'MISSING_TOKEN']),
    { ACCOUNT_TOKEN: fakeSecretValue(), MISSING_TOKEN: fakeSecretValue() }, spy,
  );
  assert.equal(spy.calls.count('open'), 1, 'the run reached the driver');
  assert.notEqual(ran.result.refusal?.code, 'secret-missing');
});

// ---- key-only redaction for short secrets -------------------------------------------------------

// The manifest's `secrets` entries, in name order.
function recordedSecrets(result: RunResult): unknown {
  const recorded = manifestField(result, 'secrets');
  if (!Array.isArray(recorded)) return recorded;
  const entries: readonly unknown[] = recorded;
  return [...entries].sort((left, right) =>
    String(Reflect.get(Object(left), 'name')).localeCompare(String(Reflect.get(Object(right), 'name'))));
}

test('a secret one character shorter than the minimum is redacted by key, and the manifest says so', async () => {
  const shortValue = fakeSecretOfLength(MINIMUM_SECRET_LENGTH - 1);
  const ran = await runWithSecrets(['SHORT_PIN'], secretFillPlan(['SHORT_PIN']), { SHORT_PIN: shortValue }, quietDriver());
  assert.ok(ran.result.manifest !== null, 'the run reached its manifest');
  assert.deepEqual(recordedSecrets(ran.result), [{ name: 'SHORT_PIN', mode: 'key-only' }]);
  assert.equal(JSON.stringify(ran.result.manifest).includes(shortValue), false, 'the manifest names the secret, not its value');
  assert.equal(ran.everything.includes(shortValue), false, 'the short value appears nowhere in the result or the log');
});

test('secrets of exactly the minimum length and longer are redacted by value, and the manifest says so', async () => {
  const environment = { EIGHT_CHARACTER_CODE: fakeSecretOfLength(MINIMUM_SECRET_LENGTH), ACCOUNT_TOKEN: fakeSecretValue() };
  const names = Object.keys(environment);
  const ran = await runWithSecrets(names, secretFillPlan(names), environment, quietDriver());
  assert.ok(ran.result.manifest !== null, 'the run reached its manifest');
  assert.deepEqual(recordedSecrets(ran.result), [
    { name: 'ACCOUNT_TOKEN', mode: 'value' },
    { name: 'EIGHT_CHARACTER_CODE', mode: 'value' },
  ]);
  for (const value of Object.values(environment)) assert.deepEqual(echoesIn(JSON.stringify(ran.result.manifest), value), []);
});

test('lengthening a short secret by one character turns its recorded mode from key-only to value', async () => {
  const shortValue = fakeSecretOfLength(MINIMUM_SECRET_LENGTH - 1);
  const short = await runWithSecrets(['SHORT_PIN'], secretFillPlan(['SHORT_PIN']), { SHORT_PIN: shortValue }, quietDriver());
  const lengthened = await runWithSecrets(['SHORT_PIN'], secretFillPlan(['SHORT_PIN']), { SHORT_PIN: `${shortValue}x` }, quietDriver());
  assert.deepEqual(recordedSecrets(short.result), [{ name: 'SHORT_PIN', mode: 'key-only' }]);
  assert.deepEqual(recordedSecrets(lengthened.result), [{ name: 'SHORT_PIN', mode: 'value' }]);
  assert.notEqual(short.result.manifestHash, lengthened.result.manifestHash, 'the manifest hash covers the redaction mode');
});

test('a run whose plan uses no secret has no secrets field in its manifest', async () => {
  const ran = await runWithSecrets(['SHORT_PIN'], secretFillPlan([]), { SHORT_PIN: fakeSecretOfLength(4) }, quietDriver());
  assert.ok(ran.result.manifest !== null, 'the run reached its manifest');
  assert.equal(Object.hasOwn(ran.result.manifest, 'secrets'), false, JSON.stringify(ran.result.manifest));
});
