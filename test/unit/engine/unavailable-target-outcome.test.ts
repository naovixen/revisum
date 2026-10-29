// What an unavailable target means for the whole run: a required target fails it with its own exit
// code, and an optional one is marked skipped with a warning, so neither passes silently.
// See docs/specs/SPEC-05-target-matrix-and-lock.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unavailableTargetOutcome, type ExitCode } from '@revisum/engine';
import { projectWith, targetInput, targetOf } from './target-examples.ts';

// The exit code SPEC-11 gives "a required target is unavailable".
const REQUIRED_TARGET_UNAVAILABLE: ExitCode = 3;

const project = projectWith([
  targetInput('chromium-default', 'fake-chromium', 'chromium', 'desktop-1280'),
  targetInput('chromium-required', 'fake-chromium', 'chromium', 'desktop-1280', { required: true }),
  targetInput('webkit-optional', 'fake-webkit', 'webkit', 'phone-390', { required: false }),
]);

test('an unavailable required target makes the run exit 3', { criterion: 'AC-SPEC-05-05' }, () => {
  assert.deepEqual(unavailableTargetOutcome(targetOf(project, 'chromium-required')), { exitCode: REQUIRED_TARGET_UNAVAILABLE });
});

test('a target that does not say whether it is required is required', { criterion: 'AC-SPEC-05-05' }, () => {
  assert.deepEqual(unavailableTargetOutcome(targetOf(project, 'chromium-default')), { exitCode: REQUIRED_TARGET_UNAVAILABLE });
});

test('an unavailable optional target is skipped with a warning that names it, and does not fail the run', { criterion: 'AC-SPEC-05-05' }, () => {
  const outcome = unavailableTargetOutcome(targetOf(project, 'webkit-optional'));
  assert.equal(outcome.exitCode, 0);
  assert.ok('skipped' in outcome && outcome.skipped === true, 'marked skipped');
  assert.ok('warning' in outcome && typeof outcome.warning === 'string', 'carries a warning');
  assert.ok(outcome.warning.includes('webkit-optional'), `the warning names the target: ${outcome.warning}`);
});

test('counter-example: the required outcome is neither skipped nor silent', { criterion: 'AC-SPEC-05-05' }, () => {
  const required = unavailableTargetOutcome(targetOf(project, 'chromium-required'));
  const optional = unavailableTargetOutcome(targetOf(project, 'webkit-optional'));
  assert.notDeepEqual(required, optional);
  assert.ok(!('skipped' in required), 'a required target is never reported skipped');
  assert.notEqual(required.exitCode, 0);
});

test('a project whose target gives required as anything but true or false is rejected at its JSON path', { criterion: 'AC-SPEC-05-05' }, () => {
  assert.throws(
    () => projectWith([targetInput('chromium-unclear', 'fake-chromium', 'chromium', 'desktop-1280', { required: 'yes' })]),
    /\$\.matrix\[0\]\.required/,
  );
});
