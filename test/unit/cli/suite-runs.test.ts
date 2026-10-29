// runSuite runs a declared suite end to end on a fake workload runner, so these run in npm run
// check with no Docker. The fake plays the suite's part: it writes the JSON report where it was
// told to and returns an exit code, a timeout flag and what the suite printed.
//   - Egress that cannot be enforced refuses the run, and no suite code runs (AC-07).
//   - The suite gets the declared variables and Revisum's own, with secrets still opaque (AC-06).
//   - Revisum's arguments reach the suite, declared shell text stays literal, and the report is
//     read from Revisum's output directory (AC-12).
//   - A timed-out suite ends Errored with suite-timeout, and no unfinished test passes (AC-13).
//   - A secret the suite prints or puts in its error message is in no form in the result (AC-08,
//     the part for standard output, standard error and the error message).
//   - The manifest's evidence record pins the suite files, command, image and self-reported
//     versions; one byte of one suite file changes its hash, and replay is not claimed (AC-19).
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { leakScanner, replayManifest, type RunResult } from '@revisum/engine';
import { recordedReport, testsOf, testTitled } from '../engine/evidence-examples.ts';
import { withValue } from '../engine/plan-examples.ts';
import { echoForms, echoesIn, fakeSecretValue, resolvedSecret } from '../engine/secret-examples.ts';
import { isRevisumOwnName } from '../runner/workload-examples.ts';
import {
  APPLICATION_FILE, DECLARED_SECRET, REPORT_VARIABLE, SUITE_FILES, carriesCode, evidenceProject, holdsSecretObject, outputFolder,
  reportWithFailure, reportWithUnfinishedTest, runDeclaredSuite, suiteCheckout, suiteRequestOf, variable,
} from './suite-run-examples.ts';

const DECLARED_COMMAND = ['npx', 'playwright', 'test'];

// ---- Egress that cannot be enforced ----------------------------------------------------------------

test('a workload runner that cannot enforce egress makes the run Refused with egress-unenforceable', { criterion: 'AC-SPEC-35-07' }, async () => {
  const { result } = await runDeclaredSuite({ behaviour: { refusal: 'egress-unenforceable' } });
  assert.equal(result.state, 'Refused');
  assert.equal(result.refusal?.code, 'egress-unenforceable');
});

test('after the refusal nothing else is run: no setup, no suite, and no test result', { criterion: 'AC-SPEC-35-07' }, async () => {
  const { result, runner } = await runDeclaredSuite({ behaviour: { refusal: 'egress-unenforceable' } });
  assert.ok(runner.requests.length <= 1, `the runner was asked ${runner.requests.length} times`);
  assert.deepEqual(result.suite?.tests ?? [], []);
});

test('counter-example: with egress enforced, the same suite runs and is not refused', { criterion: 'AC-SPEC-35-07' }, async () => {
  const { result } = await runDeclaredSuite();
  assert.notEqual(result.state, 'Refused');
  assert.equal(result.state, 'Passed');
});

// ---- The suite's environment -----------------------------------------------------------------------------

test('the suite is given only the declared variables and Revisum\'s own', { criterion: 'AC-SPEC-35-06' }, async () => {
  const { runner } = await runDeclaredSuite();
  const names = suiteRequestOf(runner).environment.map((entry) => entry.name);
  assert.deepEqual(names.filter((name) => !['BASE_URL', DECLARED_SECRET].includes(name) && !isRevisumOwnName(name)), []);
  assert.deepEqual(names.filter((name) => name.startsWith('GITHUB_')), []);
});

test('the declared secret is handed to the runner as an opaque secret, never as its text', { criterion: 'AC-SPEC-35-06' }, async () => {
  const secretValue = fakeSecretValue();
  const { runner } = await runDeclaredSuite({ secretValue });
  const request = suiteRequestOf(runner);
  assert.ok(holdsSecretObject(request, DECLARED_SECRET), 'the secret was revealed before the runner');
  assert.deepEqual(echoesIn(JSON.stringify(request), secretValue), []);
});

test('counter-example: the declared literal reaches the suite as written', { criterion: 'AC-SPEC-35-06' }, async () => {
  const { runner } = await runDeclaredSuite();
  assert.equal(variable(suiteRequestOf(runner), 'BASE_URL'), 'http://127.0.0.1:4173');
});

// ---- The command ------------------------------------------------------------------------------------------

test('the suite runs with the declared command, then --retries=0, the JSON reporter, traces on and its project', { criterion: 'AC-SPEC-35-12' }, async () => {
  const { runner } = await runDeclaredSuite();
  const argv = suiteRequestOf(runner).argv;
  assert.deepEqual(argv.slice(0, DECLARED_COMMAND.length), DECLARED_COMMAND);
  for (const argument of ['--retries=0', '--reporter=json', '--trace=on']) assert.ok(argv.includes(argument), `${argument} is missing: ${JSON.stringify(argv)}`);
  assert.ok(argv.includes('--project=chromium') || argv.join(' ').includes('--project chromium'), JSON.stringify(argv));
});

test('declared arguments of "; rm -rf /" and "$(id)" reach the runner as literal, separate strings', { criterion: 'AC-SPEC-35-12' }, async () => {
  const hostile = [...DECLARED_COMMAND, '; rm -rf /', '$(id)'];
  const { runner } = await runDeclaredSuite({ project: evidenceProject({ command: hostile }) });
  assert.deepEqual(suiteRequestOf(runner).argv.slice(0, hostile.length), hostile);
});

test('the report the suite wrote into Revisum\'s output directory is the one the result is built from', { criterion: 'AC-SPEC-35-12' }, async () => {
  const { result, runner, outputDirectory } = await runDeclaredSuite();
  assert.equal(suiteRequestOf(runner).outputDirectory, outputDirectory);
  assert.ok(variable(suiteRequestOf(runner), REPORT_VARIABLE) !== undefined);
  // The passing report holds four tests: one in two projects, and two more.
  assert.equal(testsOf(result).length, 4);
});

// ---- Timeouts --------------------------------------------------------------------------------------------

test('the declared timeout is passed to the workload runner', { criterion: 'AC-SPEC-35-13' }, async () => {
  const { runner } = await runDeclaredSuite({ project: evidenceProject({ timeoutMilliseconds: 120_000 }) });
  assert.equal(suiteRequestOf(runner).timeoutMilliseconds, 120_000);
});

test('a suite stopped at its timeout, with no report, ends Errored with suite-timeout', { criterion: 'AC-SPEC-35-13' }, async () => {
  const { result } = await runDeclaredSuite({ behaviour: { timedOut: true, exitCode: 137 } });
  assert.equal(result.state, 'Errored');
  assert.ok(carriesCode(result, 'suite-timeout'), JSON.stringify(result));
});

test('a suite stopped at its timeout reports its unfinished test interrupted, never passed', { criterion: 'AC-SPEC-35-13' }, async () => {
  const { result } = await runDeclaredSuite({ behaviour: { report: reportWithUnfinishedTest(), timedOut: true, exitCode: 137 } });
  assert.equal(result.state, 'Errored');
  assert.ok(carriesCode(result, 'suite-timeout'));
  assert.equal(testTitled(result, 'pays with a saved card', 'firefox').outcome, 'interrupted');
});

test('a timed-out suite never reports a test passed that the report does not show finished', { criterion: 'AC-SPEC-35-13' }, async () => {
  const { result } = await runDeclaredSuite({ behaviour: { report: reportWithUnfinishedTest(), timedOut: true, exitCode: 137 } });
  const finishedPassing = ['pays with a saved card|chromium', 'lists past orders|chromium'];
  const passed = testsOf(result).filter((entry) => entry.outcome === 'passed').map((entry) => `${entry.titlePath.at(-1)}|${entry.project}`);
  assert.ok(passed.every((key) => finishedPassing.includes(key)), JSON.stringify(passed));
});

test('counter-example: the same suite finishing in time ends Passed, with no suite-timeout', { criterion: 'AC-SPEC-35-13' }, async () => {
  const { result } = await runDeclaredSuite();
  assert.equal(result.state, 'Passed');
  assert.equal(carriesCode(result, 'suite-timeout'), false);
});

// ---- Secrets the suite prints ----------------------------------------------------------------------------

const MESSAGE_MARKER = 'sign-in refused for token';

async function echoingRun(secretValue: string): Promise<RunResult> {
  const forms = echoForms(secretValue);
  const echoes = [forms.raw, forms.uri, forms.base64, forms.base64url, forms.prefix, forms.upper, forms.lower].join(' ');
  const { result } = await runDeclaredSuite({
    secretValue,
    behaviour: { report: reportWithFailure(`Error: ${MESSAGE_MARKER} ${echoes}`), exitCode: 1, stdout: `token: ${echoes}\n`, stderr: `warning: ${echoes}\n` },
  });
  return result;
}

test('a secret the suite writes to its output and error message appears in the result in no form', { criterion: 'AC-SPEC-35-08' }, async () => {
  const secretValue = fakeSecretValue();
  assert.deepEqual(echoesIn(JSON.stringify(await echoingRun(secretValue)), secretValue), []);
});

test('the leak scan finds no echo in the result, and finds the planted canary', { criterion: 'AC-SPEC-35-08' }, async () => {
  const secretValue = fakeSecretValue();
  const folder = outputFolder();
  const resultFile = join(folder, 'result.json');
  const canaryFile = join(folder, 'canary.txt');
  writeFileSync(resultFile, JSON.stringify(await echoingRun(secretValue)));
  writeFileSync(canaryFile, `the suite printed ${secretValue}`);
  const secret = resolvedSecret(DECLARED_SECRET, secretValue);
  assert.deepEqual(leakScanner().scan([resultFile], [secret]), []);
  assert.ok(leakScanner().scan([canaryFile], [secret]).length >= 1, 'the scan cannot see the planted canary');
});

test('counter-example: the failed test\'s error message reaches the result, with only the secret taken out', { criterion: 'AC-SPEC-35-08' }, async () => {
  const result = await echoingRun(fakeSecretValue());
  const message = (result.suite?.findings ?? []).flatMap((finding) => finding.message).join('\n');
  assert.ok(message.includes(MESSAGE_MARKER), `the error message was dropped: ${message}`);
});

// ---- The manifest ------------------------------------------------------------------------------------------

async function manifestOf(options: Parameters<typeof runDeclaredSuite>[0] = {}) {
  const { result } = await runDeclaredSuite(options);
  assert.ok(result.manifest !== null && result.manifestHash !== null, 'the evidence run has no manifest');
  return { manifest: result.manifest, hash: result.manifestHash };
}

test('the manifest\'s evidence record names the suite and the workload image digest', { criterion: 'AC-SPEC-35-19' }, async () => {
  const image = `sha256:${'5'.repeat(64)}`;
  const { manifest } = await manifestOf({ project: evidenceProject({ image }) });
  const record = JSON.stringify(manifest.evidence);
  assert.ok(record.includes(JSON.stringify(image)), record);
  assert.ok(record.includes('"checkout"'), record);
});

test('the manifest lists suite-code, suite-browser and app-server as inputs it could not pin', { criterion: 'AC-SPEC-35-19' }, async () => {
  const { manifest } = await manifestOf();
  for (const input of ['suite-code', 'suite-browser', 'app-server']) assert.ok(manifest.nonHermeticInputs.includes(input), JSON.stringify(manifest.nonHermeticInputs));
});

test('the Playwright version the report gives is recorded, marked as self-reported', { criterion: 'AC-SPEC-35-19' }, async () => {
  const { manifest } = await manifestOf();
  const record = JSON.stringify(manifest.evidence);
  assert.ok(record.includes('1.56.1'), record);
  assert.match(record, /self.?reported/i);
});

test('the same suite files, command and image give the same manifest hash twice', { criterion: 'AC-SPEC-35-19' }, async () => {
  const checkout = suiteCheckout();
  assert.equal((await manifestOf({ checkout })).hash, (await manifestOf({ checkout })).hash);
});

test('changing one byte of one suite file changes the manifest hash', { criterion: 'AC-SPEC-35-19' }, async () => {
  const before = await manifestOf({ checkout: suiteCheckout() });
  const changed = suiteCheckout();
  const file = join(changed, 'apps/web/e2e/helpers/cart.ts');
  writeFileSync(file, readFileSync(file, 'utf8').replace('emptyCart', 'emptyCarT'));
  assert.notEqual(readFileSync(file, 'utf8'), SUITE_FILES['apps/web/e2e/helpers/cart.ts']);
  assert.notEqual((await manifestOf({ checkout: changed })).hash, before.hash);
});

test('changing the setup command, the command or the image changes the manifest hash', { criterion: 'AC-SPEC-35-19' }, async () => {
  const checkout = suiteCheckout();
  const base = (await manifestOf({ checkout })).hash;
  for (const fields of [
    { setupCommand: ['npm', 'ci', '--offline'] },
    { command: [...DECLARED_COMMAND, '--grep', 'checkout'] },
    { image: `sha256:${'6'.repeat(64)}` },
  ]) {
    assert.notEqual((await manifestOf({ checkout, project: evidenceProject(fields) })).hash, base, JSON.stringify(fields));
  }
});

test('a report giving another Playwright version changes the manifest hash', { criterion: 'AC-SPEC-35-19' }, async () => {
  const checkout = suiteCheckout();
  const base = (await manifestOf({ checkout })).hash;
  const report = withValue(recordedReport('passing-with-criteria'), ['config', 'version'], '1.57.0');
  assert.notEqual((await manifestOf({ checkout, behaviour: { report, exitCode: 0 } })).hash, base);
});

test('counter-example: editing an application file outside the suite\'s paths leaves the suite files\' hash as it was', { criterion: 'AC-SPEC-35-19' }, async () => {
  const first = suiteCheckout();
  const second = suiteCheckout();
  writeFileSync(join(second, APPLICATION_FILE), 'export const app = 2;\n');
  const [one, two] = [(await manifestOf({ checkout: first })).manifest, (await manifestOf({ checkout: second })).manifest];
  // The application is the app-server input the manifest says it cannot pin.
  assert.deepEqual(one.evidence, two.evidence);
});

// The code a replay gave back, read whether it failed with the bare code or a { code } object.
async function replayCode(manifest: Parameters<typeof replayManifest>[0]): Promise<string | null> {
  let outcome: unknown;
  try {
    outcome = await replayManifest(manifest);
  } catch {
    return null;
  }
  if (typeof outcome !== 'object' || outcome === null || Reflect.get(outcome, 'ok') !== false) return null;
  const error: unknown = Reflect.get(outcome, 'error');
  if (typeof error === 'string') return error;
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : null;
}

test('replaying an evidence manifest is refused with replay-not-claimed', { criterion: 'AC-SPEC-35-19' }, async () => {
  const { manifest } = await manifestOf();
  assert.equal(await replayCode(manifest), 'replay-not-claimed');
});

test('counter-example: the same manifest without its evidence record is not refused as replay-not-claimed', { criterion: 'AC-SPEC-35-19' }, async () => {
  const { manifest } = await manifestOf();
  const planManifest = { ...manifest };
  Reflect.deleteProperty(planManifest, 'evidence');
  assert.notEqual(await replayCode(planManifest), 'replay-not-claimed');
});
