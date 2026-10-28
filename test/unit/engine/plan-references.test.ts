// A plan may name a secret or a fixture file, but only one the trusted project declares: a fill
// value may be a reference { secretName } to a name in the project's secretNames, and an upload
// step's fixture must be in the project's fixtures. Anything else is rejected with its code and
// path, without echoing the name. The frame-depth limit lives in the project's limits too.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProject, planParser } from '@revisum/engine';
import { signupPlan, stepsOf, testProject, testProjectInput, type JsonRecord } from './plan-examples.ts';

const DECLARED_SECRET = 'SIGNUP_PASSWORD';
const DECLARED_FIXTURE = 'avatar.png';
const UNDECLARED_SECRET = 'PRODUCTION_DATABASE_PASSWORD';
const UNDECLARED_FIXTURE = 'private-marker-q7zx.png';

const parsePlan = (input: unknown) =>
  planParser(testProject({}, { secretNames: [DECLARED_SECRET], fixtures: [DECLARED_FIXTURE] }))(input);

const password = { by: 'label', label: 'Password' };
const avatar = { by: 'label', label: 'Profile picture' };

// The sign-up plan with one step inserted after its navigation, at index 1.
const planWithStep = (step: JsonRecord): JsonRecord => {
  const steps = stepsOf(signupPlan());
  return { ...signupPlan(), steps: [steps[0], step, ...steps.slice(1)] };
};

const assertRejected = (input: unknown, code: string, path: string, privateText: string, parse = parsePlan): void => {
  const parsed = parse(input);
  assert.deepEqual(parsed, { ok: false, error: [{ code, path }] });
  assert.ok(!JSON.stringify(parsed).includes(privateText), 'the error does not echo the name');
};

const assertAccepted = (input: unknown, parse = parsePlan): void => {
  const parsed = parse(input);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
};

// ---- Secret references --------------------------------------------------------------------------

test('accepts a fill whose value references a declared secret name', { criterion: 'AC-SPEC-01-03' }, () => {
  assertAccepted(planWithStep({ type: 'fill', locator: password, value: { secretName: DECLARED_SECRET } }));
});

test('rejects a fill that references an undeclared secret name, without echoing it', { criterion: 'AC-SPEC-01-03' }, () => {
  assertRejected(planWithStep({ type: 'fill', locator: password, value: { secretName: UNDECLARED_SECRET } }),
    'unknown_value', '$.steps[1].value.secretName', UNDECLARED_SECRET);
});

test('rejects any secret reference when the project declares no secret names', { criterion: 'AC-SPEC-01-03' }, () => {
  const parseWithoutSecrets = planParser(testProject());
  assertRejected(planWithStep({ type: 'fill', locator: password, value: { secretName: DECLARED_SECRET } }),
    'unknown_value', '$.steps[1].value.secretName', DECLARED_SECRET, parseWithoutSecrets);
});

test('rejects an unknown key beside a secret name', { criterion: 'AC-SPEC-01-03' }, () => {
  assertRejected(planWithStep({ type: 'fill', locator: password, value: { secretName: DECLARED_SECRET, fallback: UNDECLARED_SECRET } }),
    'unknown_field', '$.steps[1].value.fallback', UNDECLARED_SECRET);
});

test('rejects a secret reference whose name is not text', { criterion: 'AC-SPEC-01-03' }, () => {
  assertRejected(planWithStep({ type: 'fill', locator: password, value: { secretName: 7 } }), 'wrong_type', '$.steps[1].value.secretName', UNDECLARED_SECRET);
});

// ---- Upload fixtures ----------------------------------------------------------------------------

test('accepts an upload of a declared fixture', { criterion: 'AC-SPEC-01-03' }, () => {
  assertAccepted(planWithStep({ type: 'upload', locator: avatar, fixture: DECLARED_FIXTURE }));
});

test('rejects an upload of an undeclared fixture, without echoing its name', { criterion: 'AC-SPEC-01-03' }, () => {
  assertRejected(planWithStep({ type: 'upload', locator: avatar, fixture: UNDECLARED_FIXTURE }), 'unknown_value', '$.steps[1].fixture', UNDECLARED_FIXTURE);
});

test('rejects an upload that tries to reach outside the declared fixtures', { criterion: 'AC-SPEC-01-03' }, () => {
  for (const fixture of [`../${DECLARED_FIXTURE}`, `/etc/${DECLARED_FIXTURE}`, `${DECLARED_FIXTURE}/../../secrets.txt`]) {
    const parsed = parsePlan(planWithStep({ type: 'upload', locator: avatar, fixture }));
    assert.equal(parsed.ok, false, `accepted ${fixture}`);
  }
});

test('rejects any upload when the project declares no fixtures', { criterion: 'AC-SPEC-01-03' }, () => {
  assertRejected(planWithStep({ type: 'upload', locator: avatar, fixture: DECLARED_FIXTURE }),
    'unknown_value', '$.steps[1].fixture', DECLARED_FIXTURE, planParser(testProject()));
});

// ---- The project declares secret names, fixtures and the frame-depth limit ------------------------

test('a project without secret names or fixtures still parses: both default to empty', { criterion: 'AC-SPEC-01-03' }, () => {
  assert.equal(parseProject(testProjectInput()).ok, true);
});

test('the project rejects secret names and fixtures that are not lists of text', { criterion: 'AC-SPEC-01-03' }, () => {
  for (const fields of [{ secretNames: DECLARED_SECRET }, { secretNames: [7] }, { fixtures: { avatar: DECLARED_FIXTURE } }, { fixtures: [null] }]) {
    assert.equal(parseProject(testProjectInput({}, fields)).ok, false, `accepted ${JSON.stringify(fields)}`);
  }
});

test('the project accepts maximumFrameDepth within its limits', { criterion: 'AC-SPEC-01-11' }, () => {
  assert.equal(parseProject(testProjectInput({ maximumFrameDepth: 3 })).ok, true);
});

test('the project rejects a maximumFrameDepth that is not a positive whole number', { criterion: 'AC-SPEC-01-11' }, () => {
  for (const depth of [0, -1, 1.5]) {
    assert.equal(parseProject(testProjectInput({ maximumFrameDepth: depth })).ok, false, `accepted ${depth}`);
  }
  assert.deepEqual(parseProject({ ...testProjectInput(), limits: { maximumFrameDepth: 'deep' } }), {
    ok: false, error: [{ code: 'wrong_type', path: '$.limits.maximumFrameDepth' }],
  });
});

test('maximumFrameDepth outside limits is an unknown project field', { criterion: 'AC-SPEC-01-11' }, () => {
  assert.deepEqual(parseProject({ ...testProjectInput(), maximumFrameDepth: 2 }), {
    ok: false, error: [{ code: 'unknown_field', path: '$.maximumFrameDepth' }],
  });
});
