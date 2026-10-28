// The examples the evidence-mode tests share: a suite declaration in the shared test project, the
// recorded Playwright JSON reports under fixtures/evidence-mode/reports/, and the calls that turn
// a decoded report into a run result.
//
// Evidence mode runs a team's own Playwright suite and wraps it with Revisum's evidence. Only the
// trusted project file turns it on, in its evidenceMode section; its suite paths become trusted
// files; parseSuiteReport decodes the suite's JSON report, which arrives as unknown; and
// evidenceResult maps the decoded report into a run result labelled mode 'evidence' with the
// 'host' guarantee level.
//
// The spec names parseProject's new section, parseSuiteReport, evidenceResult and the types. The
// shapes below it leaves open are used only in this file, so settling them changes one place:
//   - parseSuiteReport takes the report as parsed JSON (reportInput below), not as bytes;
//   - an attachment path inside Revisum's output directory is written relative to it
//     (ATTACHMENT_INSIDE_OUTPUT below);
//   - EvidenceContext is { suite, pass, exitCode, redactor }: the declared suite, which pass this
//     is, the suite command's exit code, and the redactor every kept text goes through;
//   - declaredSuite(project, name) picks the suite `run --suite <name>` runs, or refuses with
//     evidence-mode-disabled or suite-not-declared before any container starts;
//   - suitePasses(suite, changedFiles) lists the passes a change gets, each with the version of
//     the suite files it runs: the gating pass always the protected branch's, the proposal pass,
//     when there is one, the change's own;
//   - evidenceMergeGateOpen(result) says whether an evidence result may open the merge gate.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  declaredSuite, defaultRedactor, evidenceMergeGateOpen, evidenceResult, parseProject, parseSuiteReport, suitePasses,
  type EvidenceContext, type EvidenceLimits, type EvidenceSuiteDeclaration, type Project, type ProjectData, type RunResult, type SuiteDecodeError,
  type SuiteReport,
} from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';
import { projectFileWith, type JsonRecord } from './run-value-examples.ts';

export type { JsonRecord };

export const SUITE_NAME = 'checkout';
// A workload image pinned by digest. A test value: no such image exists.
export const IMAGE_DIGEST = `sha256:${'0123456789abcdef'.repeat(4)}`;
// A secret the shared test project declares (plan-examples.ts), which a suite may receive.
export const DECLARED_SECRET = 'SHOP_API_TOKEN';
export const SUITE_FOLDER = 'apps/web';

// The suite declaration as a person writes it in project.json. `fields` adds or replaces fields.
export const suiteInput = (fields: JsonRecord = {}): JsonRecord => ({
  name: SUITE_NAME,
  framework: 'playwright-test',
  paths: [`${SUITE_FOLDER}/e2e/**`, `${SUITE_FOLDER}/playwright.config.ts`],
  workingDirectory: SUITE_FOLDER,
  image: IMAGE_DIGEST,
  setupCommand: ['npm', 'ci'],
  command: ['npx', 'playwright', 'test'],
  projects: ['chromium'],
  environment: { BASE_URL: { literal: 'http://127.0.0.1:4173' }, [DECLARED_SECRET]: { secretName: DECLARED_SECRET } },
  ...fields,
});

// The evidenceMode section with the given suites, and limits when given.
export const evidenceModeInput = (suites: readonly unknown[] = [suiteInput()], limits?: JsonRecord): JsonRecord =>
  limits === undefined ? { suites } : { suites, limits };

// The shared test project file with an evidenceMode section.
export const projectFileWithEvidence = (section: unknown = evidenceModeInput()): JsonRecord => projectFileWith({ evidenceMode: section });

export function parsedProject(projectFile: unknown): Project {
  const parsed = parseProject(projectFile);
  assert.ok(parsed.ok, `the project was rejected: ${JSON.stringify(parsed)}`);
  return parsed.value;
}

// The one suite the shared evidence project declares, as the parser returns it.
export function declaredCheckoutSuite(fields: JsonRecord = {}): EvidenceSuiteDeclaration {
  const suite = parsedProject(projectFileWithEvidence(evidenceModeInput([suiteInput(fields)]))).evidenceMode?.suites[0];
  assert.ok(suite !== undefined, 'the parsed project has no suite');
  return suite;
}

// The evidence limits the shared evidence project parses to, with some tightened.
export function evidenceLimits(overrides: Partial<EvidenceLimits> = {}): EvidenceLimits {
  const limits = parsedProject(projectFileWithEvidence()).evidenceMode?.limits;
  assert.ok(limits !== undefined, 'the parsed project has no evidence limits');
  return { ...limits, ...overrides };
}

// ---- Recorded reports -------------------------------------------------------------------------

export type ReportName = 'each-outcome' | 'passing-with-criteria';

// A fresh copy of a recorded report, as JSON.parse reads it from disk.
export const recordedReport = (name: ReportName): JsonRecord =>
  JSON.parse(readFileSync(join(FIXTURES, 'evidence-mode', 'reports', `${name}.json`), 'utf8'));

// The JSON path of spec `index` in the recorded reports' one describe block, as a withValue path.
export const specPath = (index: number): (string | number)[] => ['suites', 0, 'suites', 0, 'specs', index];
export const specJsonPath = (index: number): string => `$.suites[0].suites[0].specs[${index}]`;

// The titles of the each-outcome report's specs, by index, with the status each one's result has.
export const EACH_OUTCOME = [
  { title: 'adds an item to the cart', status: 'passed', outcome: 'passed' },
  { title: 'shows the order total', status: 'failed', outcome: 'failed' },
  { title: 'confirms the payment', status: 'timedOut', outcome: 'timed-out' },
  { title: 'applies a gift card', status: 'skipped', outcome: 'skipped' },
  { title: 'sends the receipt', status: 'interrupted', outcome: 'interrupted' },
] as const;
export const INTERRUPTED_SPEC = 4;

// A copy of `report` without spec `index` of its one describe block.
export function withoutSpec(report: JsonRecord, index: number): JsonRecord {
  const copy = structuredClone(report);
  const describe = ((copy['suites'] as JsonRecord[])[0]?.['suites'] as JsonRecord[])[0];
  assert.ok(describe !== undefined, 'the report has no describe block');
  (describe['specs'] as unknown[]).splice(index, 1);
  return copy;
}

// An attachment path inside Revisum's output directory, as the decoder accepts it.
export const ATTACHMENT_INSIDE_OUTPUT = 'test-results/checkout-shows-the-order-total-chromium/trace.zip';

// The report in the form parseSuiteReport takes.
export const reportInput = (report: unknown): unknown => report;

export const decodeReport = (report: unknown, limits: EvidenceLimits = evidenceLimits()) =>
  parseSuiteReport(reportInput(report), limits);

export function decodedReport(report: unknown, limits: EvidenceLimits = evidenceLimits()): SuiteReport {
  const decoded = decodeReport(report, limits);
  assert.ok(decoded.ok, `the report was refused: ${JSON.stringify(decoded)}`);
  return decoded.value;
}

export function refusal(report: unknown, limits: EvidenceLimits = evidenceLimits()): readonly SuiteDecodeError[] {
  const decoded = decodeReport(report, limits);
  assert.equal(decoded.ok, false, 'the report was accepted');
  return decoded.ok ? [] : decoded.error;
}

// ---- Evidence results ---------------------------------------------------------------------------

export type Pass = 'gating' | 'proposal';
export type EvidenceOptions = {
  readonly suite?: EvidenceSuiteDeclaration;
  readonly pass?: Pass;
  // The suite command's exit code. By default the one Playwright gives for the report's outcomes:
  // 1 when any test failed, timed out or was interrupted, otherwise 0.
  readonly exitCode?: number;
};

const FAILING_STATUSES = new Set(['failed', 'timedOut', 'interrupted']);

// The status of every test result in a report, found wherever a "results" list sits.
function resultStatuses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(resultStatuses);
  if (typeof value !== 'object' || value === null) return [];
  const entries = Object.entries(value);
  const results = entries.find(([key]) => key === 'results')?.[1];
  const own = Array.isArray(results)
    ? results.map((entry: unknown) => (typeof entry === 'object' && entry !== null ? String(Object.entries(entry).find(([key]) => key === 'status')?.[1]) : ''))
    : [];
  return [...own, ...entries.filter(([key]) => key !== 'results').flatMap(([, nested]) => resultStatuses(nested))];
}

// The exit code Playwright Test gives for a report: 1 when any result failed, timed out or was
// interrupted, otherwise 0.
export const agreeingExitCode = (report: unknown): number => (resultStatuses(report).some((status) => FAILING_STATUSES.has(status)) ? 1 : 0);

export function evidenceContext(report: unknown, options: EvidenceOptions = {}): EvidenceContext {
  return {
    suite: options.suite ?? declaredCheckoutSuite(),
    pass: options.pass ?? 'gating',
    exitCode: options.exitCode ?? agreeingExitCode(report),
    redactor: defaultRedactor(),
  };
}

// The run result for a recorded report: decoded, then mapped with no traces and no audit findings.
export function evidenceRun(report: unknown, options: EvidenceOptions = {}): RunResult {
  return evidenceResult(decodedReport(report), [], [], evidenceContext(report, options));
}

// The suite's test entries: one per test and project.
export function testsOf(result: RunResult) {
  const suite = result.suite;
  assert.ok(suite !== undefined, 'the evidence result has no suite');
  return suite.tests;
}

export function testTitled(result: RunResult, title: string, project = 'chromium') {
  const found = testsOf(result).find((entry) => entry.titlePath.at(-1) === title && entry.project === project);
  assert.ok(found !== undefined, `no test titled "${title}" in ${project}`);
  return found;
}

// The codes of the result's review items, as plain strings.
export const reviewCodes = (result: RunResult): string[] => (result.reviewItems ?? []).map((item) => String(item.code));

// ---- Choosing a suite, its passes and the merge gate --------------------------------------------

// Takes a parsed or a trusted project: both carry the project's data.
export const chooseSuite = (project: ProjectData, name: string) => declaredSuite(project, name);

export const passesFor = (suite: EvidenceSuiteDeclaration, changedFiles: readonly string[]) => suitePasses(suite, changedFiles);

export const opensMergeGate = (result: RunResult): boolean => evidenceMergeGateOpen(result);

// ---- Values no output may hold --------------------------------------------------------------------

// A text no error may contain: it stands for the hostile or private value in an input.
export const HOSTILE_MARKER = 'hostile-marker-v3kq';

const letters = (count: number): string => {
  let text = '';
  while (text.length < count) text += randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return text.slice(0, count);
};
// A fresh token-shaped fake with a well-known issuer prefix, made at run time so no file holds one.
export const tokenShapedText = (): string => `ghp_${letters(36)}`;
