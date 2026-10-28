// Maps a decoded suite report into a run result labelled mode 'evidence': one entry per test and
// project, a fail finding for each failed or timed-out test, criterion ids from the suite's
// "criterion" annotations, and the guarantee statement, which is always at the 'host' level. Every
// text the report holds goes through the run's redactor and is kept only as safe text, or as its
// sha256. A result built here is never verified evidence: it says what the suite reported.
// See docs/specs/SPEC-35-evidence-mode.md.
import {
  SUITE_CRITERION_LINK,
  type A11yFinding, type CriterionId, type EvidenceSuiteDeclaration, type Redactor, type SafeText, type SuiteFinding, type SuiteLocation,
  type SuitePass, type SuiteTestId, type SuiteTestOutcome, type SuiteTestResult,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import { guaranteeStatement } from '../guarantees.ts';
import { canonicalJson, sha256 } from '../hashing.ts';
import type { TerminalState } from '../lifecycle.ts';
import { runTimeTextOrDigest } from '../plan/plan-decoders.ts';
import { CRITERION_ID } from '../plan/plan-grammar.ts';
import { withResultHash } from '../result-hash.ts';
import type { RunResult, RunReviewItem } from '../run.ts';
import type { SuiteReport, SuiteReportTest, SuiteTrace } from './suite-report.ts';

// What the result builder needs besides the decoded outputs: the declared suite, which pass this
// is, the suite command's exit code, and the redactor every kept text goes through.
export type EvidenceContext = {
  readonly suite: EvidenceSuiteDeclaration;
  readonly pass: SuitePass;
  readonly exitCode: number;
  readonly redactor: Redactor;
};

const CRITERION_ANNOTATION = 'criterion';
const MAXIMUM_KEPT_TEXT_LENGTH = 2000;
const MAXIMUM_MESSAGE_LINES = 40;
// Terminal colour codes, which Playwright writes into error messages.
const TERMINAL_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;
// The outcomes that make Playwright Test exit with 1.
const FAILING_OUTCOMES: readonly SuiteTestOutcome[] = ['failed', 'timed-out', 'interrupted'];
// The outcomes that become a fail finding. An interrupted test did not finish, so it says nothing
// about the product; it makes the run Errored instead.
const FINDING_OUTCOMES: readonly SuiteTestOutcome[] = ['failed', 'timed-out'];

// A text from the report, as it may be kept: redacted, then safe text or its sha256.
const keptText = (raw: string, redactor: Redactor): SafeText => runTimeTextOrDigest(redactor.text(raw), MAXIMUM_KEPT_TEXT_LENGTH);

// The sha256 of the test's file, title path and project, as the report gives them.
const suiteTestId = (test: SuiteReportTest): SuiteTestId =>
  brand<string, 'SuiteTestId'>(sha256(canonicalJson({ file: test.file, titlePath: test.titlePath, project: test.project })));

// The exit code Playwright Test gives for these outcomes: 1 when any test failed, timed out or was
// interrupted, otherwise 0.
const agreeingExitCode = (outcomes: readonly SuiteTestOutcome[]): number => (outcomes.some((outcome) => FAILING_OUTCOMES.includes(outcome)) ? 1 : 0);

// The criterion ids a test's annotations link, and the index of each criterion annotation whose
// description is not a valid id, which is dropped and raised for review without its text.
function linkedCriteria(test: SuiteReportTest): { readonly criterionIds: readonly CriterionId[]; readonly invalid: readonly number[] } {
  const criterionIds: CriterionId[] = [];
  const invalid: number[] = [];
  test.annotations.forEach((annotation, index) => {
    if (annotation.type !== CRITERION_ANNOTATION) return;
    const description = annotation.description;
    if (description === undefined || !CRITERION_ID.test(description)) { invalid.push(index); return; }
    const criterionId = brand<string, 'CriterionId'>(description);
    if (!criterionIds.includes(criterionId)) criterionIds.push(criterionId);
  });
  return { criterionIds, invalid };
}

// The redacted message, one line each, with colour codes and blank lines left out.
const messageLines = (message: string, redactor: Redactor): SafeText[] =>
  message.replace(TERMINAL_ESCAPE, '').split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, MAXIMUM_MESSAGE_LINES)
    .map((line) => keptText(line, redactor));

// The actions of the test's trace, found by the trace attachments it has.
function traceSteps(test: SuiteReportTest, traces: readonly SuiteTrace[], redactor: Redactor): SafeText[] {
  const attached = new Set(test.attachments.flatMap((attachment) => (attachment.path === undefined ? [] : [attachment.path])));
  return traces.filter((trace) => attached.has(trace.attachmentPath)).flatMap((trace) => trace.actions.map((action) => keptText(action, redactor)));
}

function failFinding(
  test: SuiteReportTest, id: SuiteTestId, criterionIds: readonly CriterionId[], traces: readonly SuiteTrace[], redactor: Redactor,
): SuiteFinding {
  const error = test.errors[0];
  const location: SuiteLocation | undefined = error?.location === undefined
    ? undefined : { file: keptText(error.location.file, redactor), line: error.location.line, column: error.location.column };
  return {
    id: sha256(canonicalJson({ finding: 'fail', testId: id })), testId: id, status: 'fail', criterionIds,
    ...(criterionIds.length === 0 ? {} : { criterionLink: SUITE_CRITERION_LINK }),
    steps: traceSteps(test, traces, redactor),
    message: test.errors.flatMap((each) => (each.message === undefined ? [] : messageLines(each.message, redactor))),
    ...(location === undefined ? {} : { location }),
  };
}

// Interrupted tests and a disagreeing exit code make the run Errored: it could not test. Then a
// failed or timed-out test makes it Failed; otherwise it Passed.
function evidenceState(outcomes: readonly SuiteTestOutcome[], exitCodeMismatch: boolean): Extract<TerminalState, 'Passed' | 'Failed' | 'Errored'> {
  if (exitCodeMismatch || outcomes.includes('interrupted')) return 'Errored';
  return outcomes.some((outcome) => FINDING_OUTCOMES.includes(outcome)) ? 'Failed' : 'Passed';
}

export function evidenceResult(
  report: SuiteReport, traces: readonly SuiteTrace[], audits: readonly A11yFinding[], context: EvidenceContext,
): RunResult {
  const { suite, pass, exitCode, redactor } = context;
  const tests: SuiteTestResult[] = [];
  const findings: SuiteFinding[] = [];
  const reviewItems: RunReviewItem[] = [];
  for (const test of report.tests) {
    const id = suiteTestId(test);
    const { criterionIds, invalid } = linkedCriteria(test);
    for (const annotationIndex of invalid) reviewItems.push({ code: 'spec-ambiguous', testId: id, annotationIndex });
    const finding = FINDING_OUTCOMES.includes(test.outcome) ? failFinding(test, id, criterionIds, traces, redactor) : undefined;
    if (finding !== undefined) findings.push(finding);
    tests.push({
      id, file: keptText(test.file, redactor), titlePath: test.titlePath.map((title) => keptText(title, redactor)),
      project: keptText(test.project, redactor), outcome: test.outcome, pass, criterionIds,
      ...(criterionIds.length === 0 ? {} : { criterionLink: SUITE_CRITERION_LINK }),
      findingIds: finding === undefined ? [] : [finding.id],
      // Kept traces, suite screenshots and masked captures are stored once the runner keeps them.
      artefacts: [],
    });
  }
  const outcomes = report.tests.map((test) => test.outcome);
  const exitCodeMismatch = exitCode !== agreeingExitCode(outcomes);
  return withResultHash({
    state: evidenceState(outcomes, exitCodeMismatch),
    mode: 'evidence',
    // A suite runs only inside the isolated runner, behind its egress proxy; without it the run is
    // refused with egress-unenforceable before any suite code runs.
    guarantees: guaranteeStatement({ mode: 'evidence', egressEnforced: true, unmaskedScreenshotsKept: suite.keepSuiteScreenshots }),
    targetId: suite.name,
    // The evidence manifest record is written once the runner pins the suite's inputs.
    manifest: null, manifestHash: null,
    steps: [], blockedOrigins: [], unavailable: null,
    suite: { name: suite.name, tests, findings, ...(audits.length === 0 ? {} : { accessibilityFindings: audits }) },
    evidence: { pass, exitCode, exitCodeMismatch },
    ...(reviewItems.length === 0 ? {} : { reviewItems }),
    timings: { totalMilliseconds: report.tests.reduce((total, test) => total + test.durationMilliseconds, 0), stepMilliseconds: [] },
  });
}

// True when an evidence result may open the merge gate: only a gating pass, which ran the
// protected branch's suite files, that passed with nothing left for a person to look at. A
// proposal pass ran the change's own tests, so it never does; nor does a plan run's result.
export const evidenceMergeGateOpen = (result: RunResult): boolean =>
  result.mode === 'evidence' && result.evidence?.pass === 'gating' && result.state === 'Passed' && (result.reviewItems ?? []).length === 0;
