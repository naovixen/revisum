// A browser mutant rewrites responses from declared fixture origins only. The egress policy
// builder refuses a rewrite for any other origin, so a mutant can never reach the real app or a
// third party. Accepting the same rewrite on a fixture origin is the counter-example.
// See docs/specs/SPEC-07-isolated-runner-and-egress.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEgressPolicy, type ResponseRewrite } from '@revisum/runner';
import { origin, serviceName } from './runner-examples.ts';

const FIXTURE = origin('http://127.0.0.1:4310');
const APP = origin('https://staging.example.test');
const UNDECLARED = origin('http://elsewhere.invalid');
const HEADING_CHANGED: ResponseRewrite = { name: 'heading-changed', find: 'Original heading', replace: 'Mutated heading' };

test('a rewrite on a declared fixture origin is accepted and kept in the policy', { criterion: 'AC-SPEC-07-07' }, () => {
  const built = buildEgressPolicy({
    allowOrigins: [FIXTURE, APP], allowServices: [serviceName('fixture-app')], fixtureOrigins: [FIXTURE],
    responseRewrites: [{ origin: FIXTURE, rewrite: HEADING_CHANGED }],
  });
  assert.ok(built.ok, JSON.stringify(built));
  assert.deepEqual(built.value.responseRewrites, [{ origin: FIXTURE, rewrite: HEADING_CHANGED }]);
});

test('a rewrite on a declared origin that is not a fixture origin is refused', { criterion: 'AC-SPEC-07-07' }, () => {
  const built = buildEgressPolicy({
    allowOrigins: [FIXTURE, APP], allowServices: [], fixtureOrigins: [FIXTURE],
    responseRewrites: [{ origin: APP, rewrite: HEADING_CHANGED }],
  });
  assert.ok(!built.ok);
  assert.deepEqual(built.error, { code: 'rewrite-origin-not-fixture', origin: APP });
});

test('a rewrite on an origin the policy does not even allow is refused', { criterion: 'AC-SPEC-07-07' }, () => {
  const built = buildEgressPolicy({
    allowOrigins: [FIXTURE], allowServices: [], fixtureOrigins: [FIXTURE],
    responseRewrites: [{ origin: UNDECLARED, rewrite: HEADING_CHANGED }],
  });
  assert.ok(!built.ok);
  assert.deepEqual(built.error, { code: 'rewrite-origin-not-fixture', origin: UNDECLARED });
});

test('one refused rewrite refuses the whole policy, even beside an accepted one', { criterion: 'AC-SPEC-07-07' }, () => {
  const built = buildEgressPolicy({
    allowOrigins: [FIXTURE, APP], allowServices: [], fixtureOrigins: [FIXTURE],
    responseRewrites: [{ origin: FIXTURE, rewrite: HEADING_CHANGED }, { origin: APP, rewrite: HEADING_CHANGED }],
  });
  assert.ok(!built.ok);
});

test('a policy with no rewrites carries none', { criterion: 'AC-SPEC-07-07' }, () => {
  const built = buildEgressPolicy({ allowOrigins: [APP], allowServices: [] });
  assert.ok(built.ok);
  assert.equal(built.value.responseRewrites, undefined);
  assert.equal(built.value.denyPrivateRanges, true);
});
