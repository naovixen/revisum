// A Secret is opaque: serialising, printing or inspecting it gives "[secret]", never its value.
// Only allow-listed modules may reveal it (secret-reveal-lint.test.ts in test/proofs).
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { format, inspect } from 'node:util';
import { echoesIn, fakeEnvironmentStore, fakeSecretValue, resolvedSecret, secretName } from './secret-examples.ts';

const PLACEHOLDER = '[secret]';

test('JSON.stringify of a secret gives "[secret]", alone and inside other values', { criterion: 'AC-SPEC-04-01' }, () => {
  const value = fakeSecretValue();
  const secret = resolvedSecret('ACCOUNT_TOKEN', value);
  assert.equal(JSON.stringify(secret), JSON.stringify(PLACEHOLDER));
  assert.equal(JSON.stringify({ token: secret }), `{"token":${JSON.stringify(PLACEHOLDER)}}`);
  assert.equal(JSON.stringify([secret, secret]), `[${JSON.stringify(PLACEHOLDER)},${JSON.stringify(PLACEHOLDER)}]`);
  assert.equal(JSON.stringify({ token: secret }, null, 2).includes(value), false);
});

test('String() and template literals of a secret give "[secret]"', { criterion: 'AC-SPEC-04-01' }, () => {
  const value = fakeSecretValue();
  const secret = resolvedSecret('ACCOUNT_TOKEN', value);
  assert.equal(String(secret), PLACEHOLDER);
  assert.equal(`${secret}`, PLACEHOLDER);
  assert.equal(`Bearer ${secret}`, `Bearer ${PLACEHOLDER}`);
  assert.equal(secret.toString(), PLACEHOLDER);
});

test('util.inspect of a secret gives "[secret]", even with hidden properties shown at full depth', { criterion: 'AC-SPEC-04-01' }, () => {
  const value = fakeSecretValue();
  const secret = resolvedSecret('ACCOUNT_TOKEN', value);
  assert.equal(inspect(secret), PLACEHOLDER);
  assert.equal(inspect(secret, { showHidden: true, depth: Infinity, getters: true }), PLACEHOLDER);
  assert.equal(inspect({ token: secret }), `{ token: ${PLACEHOLDER} }`);
  for (const pattern of ['%s', '%o', '%O', '%j']) {
    const printed = format(pattern, secret);
    assert.deepEqual(echoesIn(printed, value), [], `${pattern} printed ${printed}`);
  }
});

test('a secret exposes its name but no form of its value through its own properties', { criterion: 'AC-SPEC-04-01' }, () => {
  const value = fakeSecretValue();
  const secret = resolvedSecret('ACCOUNT_TOKEN', value);
  assert.equal(secret.name, secretName('ACCOUNT_TOKEN'));
  const ownValues = Reflect.ownKeys(secret).map((key) => String(Reflect.get(secret, key)));
  for (const own of ownValues) assert.deepEqual(echoesIn(own, value), [], `an own property holds ${own}`);
  assert.deepEqual(echoesIn(JSON.stringify(Object.entries(secret)), value), []);
});

test('control: the store does hold the value, so the checks above are not vacuous', { criterion: 'AC-SPEC-04-01' }, () => {
  // The same environment variable resolves, and a different name does not: the store read the value.
  const value = fakeSecretValue();
  const store = fakeEnvironmentStore({ ACCOUNT_TOKEN: value });
  assert.notEqual(store.resolve(secretName('ACCOUNT_TOKEN')), null);
  assert.equal(store.resolve(secretName('OTHER_TOKEN')), null);
  // A plain record carrying the value fails every check above.
  const plain = { name: 'ACCOUNT_TOKEN', value };
  assert.notEqual(JSON.stringify(plain), JSON.stringify(PLACEHOLDER));
  assert.notEqual(inspect(plain), PLACEHOLDER);
  assert.ok(echoesIn(JSON.stringify(plain), value).includes('raw'));
});
