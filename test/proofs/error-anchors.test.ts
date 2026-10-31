// Every error code has a docs anchor: docs/errors.md holds one "## <code>" heading per code, so
// the link errors#<code> resolves. The check runs inside `npm run lint` and fails, naming the
// code, when a heading is missing.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';

const ERRORS_PAGE = 'docs/errors.md';
const TIMEOUT = 300_000;

// Every code of every error-code union, as error-code-exhaustiveness.ts pins them.
const ERROR_CODES: Readonly<Record<string, readonly string[]>> = {
  plan: [
    'not_object', 'unknown_field', 'missing_field', 'wrong_type', 'unknown_step', 'unknown_value', 'invalid_url',
    'scheme_not_allowed', 'origin_not_allowed', 'target_not_in_matrix', 'unsafe_text', 'too_large', 'too_long',
    'duplicate', 'version_unsupported', 'empty', 'vacuous', 'no_criterion_id', 'literal_secret', 'undefined_value',
    'position_not_allowed', 'misplaced_step', 'unsafe_interpolation', 'header_not_allowed', 'command_not_allowed',
    'path_not_allowed', 'unsafe_feature_disabled',
  ],
  text: [
    'unknown-statement', 'bad-locator', 'bad-string', 'bad-indent', 'missing-header', 'duplicate-header', 'no-criterion',
    'unknown-key-name', 'too-large', 'duplicate-key', 'no-readable-form', 'missing-unsafe-mark', 'unneeded-unsafe-mark',
  ],
  suiteDecode: [
    'suite-report-missing', 'suite-report-invalid', 'suite-report-unsupported', 'trace-invalid', 'trace-unsupported', 'too-large',
  ],
  step: [
    'value-empty', 'value-unsafe', 'value-too-long', 'state-not-exposed', 'download-not-text', 'request-not-seen', 'script-result-too-large',
    'script-result-invalid', 'command-failed', 'command-timeout', 'command-output-invalid',
  ],
  serviceCall: [
    'response-not-json', 'response-too-large', 'field-missing', 'service-unreachable', 'call-timeout', 'unexpected-status',
    'egress-blocked', 'parameter-invalid', 'cleanup-failed',
  ],
  driver: [
    'not-found', 'ambiguous', 'not-actionable', 'timeout', 'navigation-failed', 'policy-denied', 'no-download', 'download-too-large',
    'storage-origin-mismatch', 'clock-runaway', 'clipboard-unavailable', 'target-crashed', 'unsupported-step', 'assertion-failed',
    'selector-invalid', 'script-failed', 'script-timeout', 'script-result-invalid',
  ],
  runner: ['image-missing', 'image-digest-mismatch', 'egress-unenforceable', 'start-failed'],
  recorder: ['no-reason', 'unknown-item', 'already-decided', 'sink-failed'],
  sink: ['not-append-only', 'write-failed'],
  cli: [
    'usage', 'config-invalid', 'untrusted-source', 'plan-rejected', 'target-unavailable', 'lock-download-failed',
    'lock-offline', 'approval-refused', 'replay-mismatch', 'internal', 'planner-endpoint-not-loopback', 'planner-call-failed',
  ],
  approval: [
    'self-approval', 'bot-or-app', 'not-code-owner', 'stale-commit', 'unknown-key', 'bad-signature', 'no-user-presence',
    'subject-mismatch', 'version-control-unavailable', 'not-maintainer', 'not-protected-branch', 'lockdown-not-declared',
  ],
  trust: ['untrusted-source', 'changed-with-code', 'no-approval'],
  refusal: [
    'origin_not_allowed', 'secret-missing', 'services-unavailable', 'evidence-mode-disabled', 'suite-not-declared', 'egress-unenforceable',
  ],
  policy: [
    'irreversible-action', 'irreversible-submit', 'destructive-navigation', 'irreversible-dialog', 'unnamed-control',
    'no-locale-patterns', 'undeclared-origin', 'production-origin', 'over-limit', 'side-effect-in-proposal',
    'inline-script-in-proposal',
  ],
};

const headingsIn = (text: string): Set<string> =>
  new Set(text.split(/\r?\n/).flatMap((line) => {
    const heading = /^##\s+(\S+)\s*$/.exec(line);
    return heading?.[1] === undefined ? [] : [heading[1]];
  }));

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

test('docs/errors.md has a "## <code>" heading for every code of every error-code union', { criterion: 'AC-SPEC-27-06' }, () => {
  const page = join(REPOSITORY_ROOT, ERRORS_PAGE);
  assert.ok(existsSync(page), `${ERRORS_PAGE} does not exist`);
  const headings = headingsIn(readFileSync(page, 'utf8'));
  const missing = Object.entries(ERROR_CODES).flatMap(([union, codes]) =>
    codes.filter((code) => !headings.has(code)).map((code) => `${union}: ${code}`));
  assert.deepEqual(missing, [], `codes with no heading in ${ERRORS_PAGE}`);
});

test('the unchanged copy of the repository, with every anchor present, passes the lint', { criterion: 'AC-SPEC-27-06', timeout: TIMEOUT }, () => {
  const outcome = scratch.lint();
  assert.equal(outcome.passed, true, outcome.failureOutput);
});

test('removing the not-append-only heading makes the lint fail and name that code', { criterion: 'AC-SPEC-27-06', timeout: TIMEOUT }, () => {
  assert.ok(existsSync(join(scratch.root, ERRORS_PAGE)), `${ERRORS_PAGE} does not exist`);
  const outcome = scratch.lintWithEdit(ERRORS_PAGE, (text) =>
    text.split('\n').filter((line) => !/^##\s+not-append-only\s*$/.test(line)).join('\n'));
  assert.equal(outcome.passed, false, 'the lint passed with the not-append-only anchor missing');
  assert.ok(outcome.failureOutput.includes('not-append-only'), `the lint failed, but did not name the code:\n${outcome.failureOutput}`);
});

test('removing the vacuous heading makes the lint fail and name that code', { criterion: 'AC-SPEC-27-06', timeout: TIMEOUT }, () => {
  assert.ok(existsSync(join(scratch.root, ERRORS_PAGE)), `${ERRORS_PAGE} does not exist`);
  const outcome = scratch.lintWithEdit(ERRORS_PAGE, (text) =>
    text.split('\n').filter((line) => !/^##\s+vacuous\s*$/.test(line)).join('\n'));
  assert.equal(outcome.passed, false, 'the lint passed with the vacuous anchor missing');
  assert.ok(outcome.failureOutput.includes('vacuous'), `the lint failed, but did not name the code:\n${outcome.failureOutput}`);
});
