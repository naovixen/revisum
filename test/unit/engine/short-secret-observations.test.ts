// A secret shorter than the minimum length is redacted by key: its value is never searched for in
// outputs, so what keeps it out of them is knowing where it went. A field filled from a secret
// holds the secret, so a failed check that reads that field must never keep what it read, and an
// observation that is exactly a short secret, wherever the page shows it, is redacted too. The
// driver's page really keeps what was typed (echo-page-driver.ts), so a check reads the value back
// as a browser would. Counter-examples show the run still keeps ordinary observations, and keeps
// the same text when it was typed literally rather than from a secret.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINIMUM_SECRET_LENGTH } from '@revisum/engine';
import { echoPageDriver } from './echo-page-driver.ts';
import { FAKE_TARGET, manifestField, runWithSecrets } from './secret-examples.ts';

// A seven-character access code: one shorter than the minimum, so it is redacted by key.
const SHORT_VALUE = 'Kx7pQ2m';
const SECRET = 'PIN';
const ACCESS_CODE = { by: 'label', label: 'Access code' };
const NICKNAME = { by: 'label', label: 'Nickname' };

const planOf = (steps: readonly unknown[]) => ({
  version: '1.1',
  meta: { featureId: 'SECRETS-5', specReference: 'specs/secrets.md#short', title: 'Enter an access code' },
  targets: [FAKE_TARGET],
  steps: [{ type: 'navigate', url: '/' }, ...steps],
});
const fillCode = (value: unknown) => ({ type: 'fill', locator: ACCESS_CODE, value });
// A check that can never pass, so the failed step keeps what it observed.
const wrongCheck = (locator: unknown, kind: 'valueEquals' | 'textEquals') =>
  ({ type: 'expect', locator, assert: { kind, value: 'x' }, criterionId: 'secrets.code-checked' });

test('setup: the access code is one character shorter than the minimum secret length', { criterion: 'AC-SPEC-04-05' }, () => {
  assert.equal(SHORT_VALUE.length, MINIMUM_SECRET_LENGTH - 1);
});

test('a failed check of a field filled from a short secret keeps no trace of the value in the result, the events or the manifest', { criterion: 'AC-SPEC-04-05' }, async () => {
  const driver = echoPageDriver({ secretValues: { [SECRET]: SHORT_VALUE } });
  const ran = await runWithSecrets([SECRET], planOf([fillCode({ secretName: SECRET }), wrongCheck(ACCESS_CODE, 'valueEquals')]), { [SECRET]: SHORT_VALUE }, driver);
  // The probe is live: the page holds the secret and the check read it.
  assert.equal(driver.fieldValues.get('label:Access code'), SHORT_VALUE, 'the field holds the typed secret');
  assert.ok(driver.calls.probes > 0, 'the check read the field');
  const check = ran.result.steps[2];
  assert.equal(check?.outcome, 'failed', JSON.stringify(ran.result.steps));
  assert.ok(check?.observed !== undefined && check.observed.length > 0, 'the failed check kept an observation');
  assert.equal(check.observed.includes(SHORT_VALUE), false, `the observation keeps the short secret: ${check.observed}`);
  assert.equal(ran.everything.includes(SHORT_VALUE), false, 'the short secret appears in the result or the event log');
  assert.ok(ran.result.manifest, 'the run reached its manifest');
  assert.equal(JSON.stringify(ran.result.manifest).includes(SHORT_VALUE), false, 'the manifest holds the short secret');
  assert.deepEqual(manifestField(ran.result, 'secrets'), [{ name: SECRET, mode: 'key-only' }]);
});

test('a failed check whose observation is exactly a short secret, shown elsewhere on the page, keeps no trace of it', { criterion: 'AC-SPEC-04-05' }, async () => {
  const driver = echoPageDriver({ secretValues: { [SECRET]: SHORT_VALUE }, texts: { 'shown-code': SHORT_VALUE } });
  const shownCode = { by: 'testId', testId: 'shown-code' };
  const ran = await runWithSecrets([SECRET], planOf([fillCode({ secretName: SECRET }), wrongCheck(shownCode, 'textEquals')]), { [SECRET]: SHORT_VALUE }, driver);
  const check = ran.result.steps[2];
  assert.equal(check?.outcome, 'failed', JSON.stringify(ran.result.steps));
  assert.ok(check?.observed !== undefined && check.observed.length > 0, 'the failed check kept an observation');
  assert.equal(check.observed.includes(SHORT_VALUE), false, `the observation keeps the short secret: ${check.observed}`);
  assert.equal(ran.everything.includes(SHORT_VALUE), false, 'the short secret appears in the result or the event log');
});

test('counter-example: with a short secret in the run, a failed check of a field filled with ordinary text keeps that text', { criterion: 'AC-SPEC-04-05' }, async () => {
  const driver = echoPageDriver({ secretValues: { [SECRET]: SHORT_VALUE } });
  const plan = planOf([fillCode({ secretName: SECRET }), { type: 'fill', locator: NICKNAME, value: 'Morning tea' }, wrongCheck(NICKNAME, 'valueEquals')]);
  const ran = await runWithSecrets([SECRET], plan, { [SECRET]: SHORT_VALUE }, driver);
  const check = ran.result.steps[3];
  assert.equal(check?.outcome, 'failed', JSON.stringify(ran.result.steps));
  assert.equal(check?.observed, 'Morning tea');
});

test('counter-example: the same seven characters typed as literal text, with no secret in the run, are kept', { criterion: 'AC-SPEC-04-05' }, async () => {
  const driver = echoPageDriver({});
  const ran = await runWithSecrets([SECRET], planOf([fillCode(SHORT_VALUE), wrongCheck(ACCESS_CODE, 'valueEquals')]), { [SECRET]: SHORT_VALUE }, driver);
  const check = ran.result.steps[2];
  assert.equal(check?.outcome, 'failed', JSON.stringify(ran.result.steps));
  assert.equal(check?.observed, SHORT_VALUE, 'the stub page returns what was typed, so the probe above is not vacuous');
});
