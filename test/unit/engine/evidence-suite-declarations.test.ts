// Evidence mode is turned on only in the trusted project file. Its evidenceMode section names each
// suite: the files, the workload image by digest, the Playwright Test command, the projects, the
// environment and the limits. The project parser refuses a declaration that could run something
// other than Playwright Test, reach outside the repository, override what Revisum sets itself or
// hold a secret, with the code and JSON path and never the value. Without the section, or without
// the named suite, `run --suite` is refused before any container starts.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProject } from '@revisum/engine';
import {
  DECLARED_SECRET, HOSTILE_MARKER, IMAGE_DIGEST, SUITE_FOLDER, SUITE_NAME, chooseSuite, evidenceModeInput, parsedProject,
  projectFileWithEvidence, suiteInput, tokenShapedText, type JsonRecord,
} from './evidence-examples.ts';
import { projectFileWith } from './run-value-examples.ts';

const SUITE_PATH = '$.evidenceMode.suites[0]';

// The project file whose one suite is the shared declaration with `fields` replaced.
const projectWithSuite = (fields: JsonRecord): JsonRecord => projectFileWithEvidence(evidenceModeInput([suiteInput(fields)]));

const environmentWith = (name: string, value: unknown): JsonRecord => ({ environment: { BASE_URL: { literal: 'http://127.0.0.1:4173' }, [name]: value } });

// ---- A valid declaration (the counter-example for every refusal below) --------------------------

test('a project with no evidenceMode section parses with evidence mode off', { criterion: 'AC-SPEC-35-01' }, () => {
  assert.equal(parsedProject(projectFileWith()).evidenceMode, undefined);
});

test('a valid suite declaration parses, with the defaults for every setting it leaves out', { criterion: 'AC-SPEC-35-01' }, () => {
  const evidenceMode = parsedProject(projectFileWithEvidence()).evidenceMode;
  assert.ok(evidenceMode !== undefined, 'the evidenceMode section was dropped');
  assert.deepEqual(JSON.parse(JSON.stringify(evidenceMode.suites)), [{
    name: SUITE_NAME,
    framework: 'playwright-test',
    paths: [`${SUITE_FOLDER}/e2e/**`, `${SUITE_FOLDER}/playwright.config.ts`],
    workingDirectory: SUITE_FOLDER,
    image: IMAGE_DIGEST,
    setupCommand: ['npm', 'ci'],
    command: ['npx', 'playwright', 'test'],
    projects: ['chromium'],
    environment: { BASE_URL: { literal: 'http://127.0.0.1:4173' }, [DECLARED_SECRET]: { secretName: DECLARED_SECRET } },
    runChangedTestsAsProposal: true,
    keepTraces: true,
    keepSuiteScreenshots: false,
    timeoutMilliseconds: 30 * 60 * 1000,
  }]);
});

test('an evidenceMode section without limits gets the default evidence limits', { criterion: 'AC-SPEC-35-01' }, () => {
  assert.deepEqual(parsedProject(projectFileWithEvidence()).evidenceMode?.limits, {
    maximumReportBytes: 50 * 1024 * 1024,
    maximumTests: 5000,
    maximumTraceBytes: 100 * 1024 * 1024,
    maximumTraceEntries: 20_000,
    maximumAuditedPages: 200,
  });
});

test('a command run through npx and one that calls playwright directly are both accepted', { criterion: 'AC-SPEC-35-01' }, () => {
  for (const command of [['npx', 'playwright', 'test'], ['playwright', 'test']]) {
    const parsed = parseProject(projectWithSuite({ command }));
    assert.equal(parsed.ok, true, `${command.join(' ')}: ${JSON.stringify(parsed)}`);
  }
});

// ---- Refusals, one fixture per case -------------------------------------------------------------

type DeclarationCase = { readonly name: string; readonly fields: JsonRecord; readonly code: string; readonly path: string };

const reservedName = (name: string): DeclarationCase => ({
  name: `the reserved environment name ${name}`, fields: environmentWith(name, { literal: HOSTILE_MARKER }),
  code: 'unknown_value', path: `${SUITE_PATH}.environment.${name}`,
});

const CASES: readonly DeclarationCase[] = [
  // The image must be pinned by digest.
  { name: 'an image named by tag', fields: { image: `registry.example.com/${HOSTILE_MARKER}:latest` }, code: 'wrong_type', path: `${SUITE_PATH}.image` },
  { name: 'a sha256 digest that is too short', fields: { image: `sha256:0123${HOSTILE_MARKER}` }, code: 'wrong_type', path: `${SUITE_PATH}.image` },
  { name: 'a digest of another algorithm', fields: { image: `sha512:${'ab'.repeat(64)}` }, code: 'wrong_type', path: `${SUITE_PATH}.image` },
  { name: 'an image that is not text', fields: { image: 42 }, code: 'wrong_type', path: `${SUITE_PATH}.image` },
  // The command must invoke Playwright Test.
  { name: 'a node script', fields: { command: ['node', `${HOSTILE_MARKER}.js`] }, code: 'command_not_allowed', path: `${SUITE_PATH}.command` },
  { name: 'a shell wrapping playwright test', fields: { command: ['sh', '-c', 'npx playwright test'] }, code: 'command_not_allowed', path: `${SUITE_PATH}.command` },
  { name: 'another test runner through npx', fields: { command: ['npx', 'cypress', 'run'] }, code: 'command_not_allowed', path: `${SUITE_PATH}.command` },
  { name: 'a playwright command other than test', fields: { command: ['npx', 'playwright', 'install'] }, code: 'command_not_allowed', path: `${SUITE_PATH}.command` },
  // Paths and the working directory stay inside the repository.
  { name: 'an absolute suite path', fields: { paths: [`/${HOSTILE_MARKER}/e2e/**`] }, code: 'path_not_allowed', path: `${SUITE_PATH}.paths[0]` },
  { name: 'a Windows drive suite path', fields: { paths: [`${SUITE_FOLDER}/e2e/**`, `C:\\${HOSTILE_MARKER}\\**`] }, code: 'path_not_allowed', path: `${SUITE_PATH}.paths[1]` },
  { name: 'a suite path that climbs out of the repository', fields: { paths: [`../${HOSTILE_MARKER}/**`] }, code: 'path_not_allowed', path: `${SUITE_PATH}.paths[0]` },
  { name: 'a suite path that climbs out part-way through', fields: { paths: [`${SUITE_FOLDER}/../../../${HOSTILE_MARKER}/**`] }, code: 'path_not_allowed', path: `${SUITE_PATH}.paths[0]` },
  { name: 'an absolute working directory', fields: { workingDirectory: `/${HOSTILE_MARKER}` }, code: 'path_not_allowed', path: `${SUITE_PATH}.workingDirectory` },
  { name: 'a working directory above the repository', fields: { workingDirectory: '..' }, code: 'path_not_allowed', path: `${SUITE_PATH}.workingDirectory` },
  // Revisum sets these itself; the declaration may not.
  reservedName('PATH'), reservedName('HOME'), reservedName('NODE_OPTIONS'), reservedName('PLAYWRIGHT_BROWSERS_PATH'),
  reservedName('PW_TEST_REPORTER'), reservedName('HTTPS_PROXY'), reservedName('CI'), reservedName('GITHUB_TOKEN'),
  // A secret goes through the secret store, never into the file.
  { name: 'a token-shaped environment literal', fields: environmentWith('CHECKOUT_MODE', { literal: tokenShapedText() }), code: 'literal_secret', path: `${SUITE_PATH}.environment.CHECKOUT_MODE.literal` },
  { name: 'an environment secret the project does not declare', fields: environmentWith('PAYMENT_KEY', { secretName: 'UNDECLARED_PAYMENT_KEY' }), code: 'unknown_value', path: `${SUITE_PATH}.environment.PAYMENT_KEY.secretName` },
];

for (const declaration of CASES) {
  test(`a suite declaring ${declaration.name} is refused with ${declaration.code} at ${declaration.path}`, { criterion: 'AC-SPEC-35-01' }, () => {
    const parsed = parseProject(projectWithSuite(declaration.fields));
    assert.equal(parsed.ok, false, 'the declaration was accepted');
    if (parsed.ok) return;
    assert.ok(
      parsed.error.some((error) => error.code === declaration.code && error.path === declaration.path),
      `expected ${declaration.code} at ${declaration.path}, got ${JSON.stringify(parsed.error)}`,
    );
  });
}

test('no refusal of a suite declaration echoes the value that caused it', { criterion: 'AC-SPEC-35-01' }, () => {
  const token = tokenShapedText();
  const hostile = [...CASES.map((declaration) => declaration.fields), environmentWith('CHECKOUT_MODE', { literal: token })];
  assert.ok(hostile.filter((fields) => JSON.stringify(fields).includes(HOSTILE_MARKER)).length >= 15, 'enough cases carry the marker');
  for (const fields of hostile) {
    const parsed = parseProject(projectWithSuite(fields));
    assert.equal(parsed.ok, false);
    const errors = JSON.stringify(parsed);
    assert.ok(!errors.includes(HOSTILE_MARKER) && !errors.includes(token), `an error echoed its value: ${errors}`);
  }
});

test('environment names that only resemble reserved ones are accepted', { criterion: 'AC-SPEC-35-01' }, () => {
  // The counter-example to the reserved names: the rule is the names, not any variable at all.
  for (const name of ['BASE_URL', 'E2E_USER', 'CHECKOUT_REGION']) {
    const parsed = parseProject(projectWithSuite(environmentWith(name, { literal: 'eu-west' })));
    assert.equal(parsed.ok, true, `${name}: ${JSON.stringify(parsed)}`);
  }
});

// ---- Choosing the suite to run ------------------------------------------------------------------

test('run --suite on a project with no evidenceMode section is refused with evidence-mode-disabled', { criterion: 'AC-SPEC-35-02' }, () => {
  const chosen = chooseSuite(parsedProject(projectFileWith()), SUITE_NAME);
  assert.equal(chosen.ok, false, 'a suite was chosen from a project without evidence mode');
  if (!chosen.ok) assert.equal(chosen.error.code, 'evidence-mode-disabled');
});

test('run --suite naming a suite the project does not declare is refused with suite-not-declared', { criterion: 'AC-SPEC-35-02' }, () => {
  const project = parsedProject(projectFileWithEvidence());
  for (const name of ['smoke', 'Checkout', 'checkout ', '']) {
    const chosen = chooseSuite(project, name);
    assert.equal(chosen.ok, false, `"${name}" was chosen`);
    if (!chosen.ok) assert.equal(chosen.error.code, 'suite-not-declared', `"${name}"`);
  }
});

test('run --suite naming a declared suite gets exactly that declaration', { criterion: 'AC-SPEC-35-02' }, () => {
  // The counter-example: the refusals above come from the section and the name, not from the call.
  const project = parsedProject(projectFileWithEvidence());
  const chosen = chooseSuite(project, SUITE_NAME);
  assert.ok(chosen.ok, JSON.stringify(chosen));
  assert.deepEqual(chosen.value, project.evidenceMode?.suites[0]);
});
