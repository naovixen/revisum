// What a real workload prints, and how it ends, on Docker with the fixture workload image.
//   - A fixture test that receives the declared secret writes it to standard output and standard
//     error and puts it in its error message, raw and encoded. The result holds it in no form, the
//     leak scan of the result finds nothing, and it does find the planted canary (AC-08, the part
//     for standard output, standard error and the error message).
//   - Standard output is capped at 1 MiB and says when it was cut short.
//   - A command still running at its timeout is stopped: the runner returns timedOut and leaves no
//     container or network behind (AC-13).
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { leakScanner } from '@revisum/engine';
import { DECLARED_SECRET } from '../unit/engine/evidence-examples.ts';
import { echoesIn, fakeSecretValue, resolvedSecret } from '../unit/engine/secret-examples.ts';
import { printed } from '../unit/runner/workload-examples.ts';
import { dockerIds, newIds } from './isolated-run.ts';
import { fixtureWorkloadImage, outputFolder, runFixtureSuite, runInWorkload } from './workload-run.ts';

const TIMEOUT = 600_000;
const MEBIBYTE = 1024 * 1024;
// The text fixtures/evidence-workload/suite/checkout.spec.mjs keeps around the secret.
const MESSAGE_TEXT = 'sign-in refused for token';

let image: string;
before(async () => { image = await fixtureWorkloadImage(); }, { timeout: TIMEOUT });

// ---- Secrets the suite prints --------------------------------------------------------------------------

test('a secret the fixture test prints and throws appears in the result in no form', { criterion: 'AC-SPEC-35-08', timeout: TIMEOUT }, async () => {
  const secretValue = fakeSecretValue();
  const { result } = await runFixtureSuite(image, secretValue);
  assert.equal(result.state, 'Failed', JSON.stringify(result));
  assert.deepEqual(echoesIn(JSON.stringify(result), secretValue), []);
});

test('the leak scan finds no echo in the real result, and finds the planted canary', { criterion: 'AC-SPEC-35-08', timeout: TIMEOUT }, async () => {
  const secretValue = fakeSecretValue();
  const { result } = await runFixtureSuite(image, secretValue);
  const folder = outputFolder();
  writeFileSync(join(folder, 'result.json'), JSON.stringify(result));
  writeFileSync(join(folder, 'canary.txt'), `planted: ${secretValue}`);
  const secret = resolvedSecret(DECLARED_SECRET, secretValue);
  assert.deepEqual(leakScanner().scan([join(folder, 'result.json')], [secret]), []);
  assert.ok(leakScanner().scan([join(folder, 'canary.txt')], [secret]).length >= 1, 'the scan cannot see the planted canary');
});

test('counter-example: the fixture test\'s error message reaches the result, with only the secret taken out', { criterion: 'AC-SPEC-35-08', timeout: TIMEOUT }, async () => {
  const { result } = await runFixtureSuite(image, fakeSecretValue());
  const message = (result.suite?.findings ?? []).flatMap((finding) => finding.message).join('\n');
  assert.ok(message.includes(MESSAGE_TEXT), `the error message was dropped: ${message}`);
});

test('standard output past 1 MiB is cut at 1 MiB and marked truncated', { criterion: 'AC-SPEC-35-08', timeout: TIMEOUT }, async () => {
  const outcome = await runInWorkload(image, { argv: ['node', '-e', `process.stdout.write('x'.repeat(${2 * MEBIBYTE}))`] });
  assert.ok(outcome.stdout.bytes.length <= MEBIBYTE, `${outcome.stdout.bytes.length} bytes were kept`);
  assert.equal(outcome.stdout.truncated, true);
});

test('counter-example: short output is kept whole and not marked truncated', { criterion: 'AC-SPEC-35-08', timeout: TIMEOUT }, async () => {
  const outcome = await runInWorkload(image, { argv: ['node', '-e', 'console.log("short"); console.error("also short")'] });
  assert.equal(printed(outcome.stdout).trim(), 'short');
  assert.equal(printed(outcome.stderr).trim(), 'also short');
  assert.equal(outcome.stdout.truncated, false);
});

// ---- Timeouts -----------------------------------------------------------------------------------------

const TIMEOUT_MILLISECONDS = 5_000;
// Starting and removing containers takes time of its own; the run must still end long before a
// command that never stops would.
const STOP_ALLOWANCE_MILLISECONDS = 120_000;

test('a command still running at its timeout is stopped, and the runner says it timed out', { criterion: 'AC-SPEC-35-13', timeout: TIMEOUT }, async () => {
  const containersBefore = dockerIds('containers');
  const networksBefore = dockerIds('networks');
  const started = Date.now();
  const outcome = await runInWorkload(image, {
    argv: ['node', '-e', 'console.log("started"); setInterval(() => {}, 1000)'], timeoutMilliseconds: TIMEOUT_MILLISECONDS,
  });
  assert.equal(outcome.timedOut, true);
  assert.ok(Date.now() - started < TIMEOUT_MILLISECONDS + STOP_ALLOWANCE_MILLISECONDS, `the run took ${Date.now() - started} ms`);
  assert.ok(printed(outcome.stdout).includes('started'), 'the command never started, so the timeout shows nothing');
  assert.deepEqual(newIds(containersBefore, dockerIds('containers')), [], 'a container was left behind');
  assert.deepEqual(newIds(networksBefore, dockerIds('networks')), [], 'a network was left behind');
});

test('counter-example: a command that ends within its timeout is not marked timed out', { criterion: 'AC-SPEC-35-13', timeout: TIMEOUT }, async () => {
  const outcome = await runInWorkload(image, { argv: ['node', '-e', 'console.log("done")'], timeoutMilliseconds: 60_000 });
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.exitCode, 0);
});
