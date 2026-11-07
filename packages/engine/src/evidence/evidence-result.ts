// Maps a decoded suite report into a run result labelled mode 'evidence': one entry per test and
// project, a fail finding for each failed or timed-out test, criterion ids from the suite's
// "criterion" annotations, and the guarantee statement, which is always at the 'host' level. Every
// text the report holds goes through the run's redactor and is kept only as safe text, or as its
// sha256. A result built here is never verified evidence: it says what the suite reported.
import {
  EvidenceOutcomeCode, RefusalCode, RunMode, RunReviewItemCode, SUITE_CRITERION_LINK, SuitePass, SuiteDecodeErrorCode, TerminalState,
  type A11yFinding, type CriterionId, type EvidenceRunManifest, type EvidenceSuiteDeclaration, type Redactor, type RunResult,
  type RunReviewItem, type SafeText, type SuiteDecodeError, type SuiteFinding, type SuiteLocation, type SuiteRanResult, type SuiteRefusal,
  type SuiteRefusedResult, type SuiteTestId, type SuiteTestOutcome, type SuiteTestResult,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import { guaranteeStatement } from '../guarantees.ts';
import { canonicalJson, sha256 } from '../hashing.ts';
import { manifestHash } from '../manifest.ts';
import { runTimeTextOrDigest } from '../plan/plan-decoders.ts';
import { criterionIdFrom } from '../plan/plan-parser.ts';
import { RECORD_UNREAD, RecordReadKind, readValueOr, type RecordRead } from '../run/after-the-verdict/RecordRead.ts';
import { refusedResult } from '../run/seal/RefusedResult.ts';
import { withRunHashes } from '../run/seal/WithRunHashes.ts';
import type { SuiteReport, SuiteReportTest, SuiteTrace } from './suite-report.ts';

// What the result builder needs besides the decoded outputs: the declared suite, which pass this
// is, the suite command's exit code, the redactor every kept text goes through, the manifest that
// pins its inputs and what its egress proxy refused. A suite run adds whether the runner stopped it
// at its timeout.
export type EvidenceContext = {
  readonly suite: EvidenceSuiteDeclaration;
  readonly pass: SuitePass;
  readonly exitCode: number;
  readonly redactor: Redactor;
  readonly timedOut?: boolean;
  readonly manifest: EvidenceRunManifest;
  // The origins the egress proxy blocked, as seen on the wire, or unread when what the proxy decided
  // could not be read back whole. Kept redacted: a name can carry a secret.
  readonly egress: RecordRead<readonly string[]>;
  // Why a trace the report attaches could not be read.
  readonly traceDecodeErrors?: readonly SuiteDecodeError[];
};

const CRITERION_ANNOTATION = 'criterion';
const MAXIMUM_KEPT_TEXT_LENGTH = 2000;
const MAXIMUM_MESSAGE_LINES = 40;
// A test can attach several traces, each under its own limit on actions.
const MAXIMUM_FINDING_STEPS = 20_000;
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
// description is not a valid id, or holds what the redactor removes, which is dropped and raised for
// review without its text.
function linkedCriteria(test: SuiteReportTest, redactor: Redactor): { readonly criterionIds: readonly CriterionId[]; readonly invalid: readonly number[] } {
  const criterionIds: CriterionId[] = [];
  const invalid: number[] = [];
  test.annotations.forEach((annotation, index) => {
    if (annotation.type !== CRITERION_ANNOTATION) return;
    const description = annotation.description;
    const criterionId = description === undefined || redactor.text(description) !== description ? undefined : criterionIdFrom(description);
    if (criterionId === undefined) {
      invalid.push(index);
      return;
    }
    if (!criterionIds.includes(criterionId)) criterionIds.push(criterionId);
  });
  return { criterionIds, invalid };
}

// The redacted message, one line each, with colour codes and blank lines left out.
const messageLines = (message: string, redactor: Redactor): SafeText[] =>
  message.replace(TERMINAL_ESCAPE, '').split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, MAXIMUM_MESSAGE_LINES)
    .map((line) => keptText(line, redactor));

// The actions of the test's trace, found by the trace attachments it has.
function traceActions(test: SuiteReportTest, traces: readonly SuiteTrace[]): readonly string[] {
  const attached = new Set(test.attachments.flatMap((attachment) => (attachment.path === undefined ? [] : [attachment.path])));
  return traces.filter((trace) => attached.has(trace.attachmentPath)).flatMap((trace) => trace.actions);
}

function failFinding(
  test: SuiteReportTest, id: SuiteTestId, criterionIds: readonly CriterionId[], actions: readonly string[], redactor: Redactor,
): SuiteFinding {
  const error = test.errors[0];
  const location: SuiteLocation | undefined = error?.location === undefined
    ? undefined : { file: keptText(error.location.file, redactor), line: error.location.line, column: error.location.column };
  return {
    id: sha256(canonicalJson({ finding: 'fail', testId: id })), testId: id, status: 'fail', criterionIds,
    ...(criterionIds.length === 0 ? {} : { criterionLink: SUITE_CRITERION_LINK }),
    // The last steps, since those led to the failure.
    steps: actions.slice(-MAXIMUM_FINDING_STEPS).map((action) => keptText(action, redactor)),
    message: test.errors.flatMap((each) => (each.message === undefined ? [] : messageLines(each.message, redactor))),
    ...(location === undefined ? {} : { location }),
  };
}

// Interrupted tests, a disagreeing exit code and an unread egress record make the run Errored: it
// could not test, or cannot show how. Then a failed or timed-out test, or a report with no test that
// ran, makes it Failed; otherwise it Passed.
function evidenceState(
  outcomes: readonly SuiteTestOutcome[], exitCodeMismatch: boolean, outcomeCode: EvidenceOutcomeCode | undefined,
): SuiteRanResult['state'] {
  const isStopped = outcomeCode === EvidenceOutcomeCode.SuiteTimeout || outcomeCode === EvidenceOutcomeCode.EgressUnread;
  if (isStopped || exitCodeMismatch || outcomes.includes('interrupted')) return TerminalState.Errored;
  if (outcomeCode === EvidenceOutcomeCode.Vacuous) return TerminalState.Failed;
  return outcomes.some((outcome) => FINDING_OUTCOMES.includes(outcome)) ? TerminalState.Failed : TerminalState.Passed;
}

// The guarantee statement every evidence result carries. A suite runs only inside the isolated
// runner, behind its egress proxy; without it the run is refused before any suite code runs.
const evidenceGuarantees = (context: EvidenceContext) => guaranteeStatement({
  mode: 'evidence', egressEnforced: context.egress.kind === RecordReadKind.Read, unmaskedScreenshotsKept: context.suite.keepSuiteScreenshots, unsafeFeatures: [],
});

// Each blocked origin once, redacted, in a stable order.
const keptOrigins = (context: EvidenceContext): readonly string[] =>
  [...new Set(readValueOr(context.egress, []).map((origin) => keptText(origin, context.redactor)))].sort();

// A stopped suite's exit code is the stop's, and a suite that ran no test is vacuous whatever its
// exit code says, so the caller compares neither with the outcomes.
function outcomeCodeOf(context: EvidenceContext, outcomes: readonly SuiteTestOutcome[]): EvidenceOutcomeCode | undefined {
  if (context.timedOut === true) {
    return EvidenceOutcomeCode.SuiteTimeout;
  }
  if (context.egress.kind === RecordReadKind.Unread) {
    return EvidenceOutcomeCode.EgressUnread;
  }
  return outcomes.every((outcome) => outcome === 'skipped') ? EvidenceOutcomeCode.Vacuous : undefined;
}

function unreadOutcomeCode(context: EvidenceContext, reportCode: UnreadReportCode | undefined): EvidenceOutcomeCode {
  if (context.timedOut === true) {
    return EvidenceOutcomeCode.SuiteTimeout;
  }
  return reportCode ?? EvidenceOutcomeCode.EgressUnread;
}

export function evidenceResult(
  report: SuiteReport, traces: readonly SuiteTrace[], audits: readonly A11yFinding[], context: EvidenceContext,
): SuiteRanResult {
  const { suite, pass, exitCode, redactor } = context;
  const tests: SuiteTestResult[] = [];
  const findings: SuiteFinding[] = [];
  const reviewItems: RunReviewItem[] = [];
  const decodeErrors: SuiteDecodeError[] = [...(context.traceDecodeErrors ?? [])];
  for (const [testIndex, test] of report.tests.entries()) {
    const id = suiteTestId(test);
    const { criterionIds, invalid } = linkedCriteria(test, redactor);
    for (const annotationIndex of invalid) reviewItems.push({ code: RunReviewItemCode.SpecAmbiguous, testId: id, annotationIndex });
    if (test.outcome === 'expected-failure') reviewItems.push({ code: RunReviewItemCode.ExpectedFailure, testId: id });
    const isFinding = FINDING_OUTCOMES.includes(test.outcome);
    const actions = isFinding ? traceActions(test, traces) : [];
    if (actions.length > MAXIMUM_FINDING_STEPS) {
      decodeErrors.push({ code: SuiteDecodeErrorCode.TooLarge, path: `$.tests[${testIndex}].steps` });
    }
    const finding = isFinding ? failFinding(test, id, criterionIds, actions, redactor) : undefined;
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
  const reportedProjects = new Set(report.tests.map((test) => test.project));
  for (const project of suite.projects) {
    if (!reportedProjects.has(project)) {
      reviewItems.push({ code: RunReviewItemCode.ProjectWithoutTests, project: keptText(project, redactor) });
    }
  }
  for (const decodeErrorIndex of decodeErrors.keys()) {
    reviewItems.push({ code: RunReviewItemCode.SuiteOutputUnread, decodeErrorIndex });
  }
  const outcomes = report.tests.map((test) => test.outcome);
  const outcomeCode = outcomeCodeOf(context, outcomes);
  const exitCodeMismatch = outcomeCode === undefined && exitCode !== agreeingExitCode(outcomes);
  return withRunHashes({
    state: evidenceState(outcomes, exitCodeMismatch, outcomeCode),
    mode: RunMode.Evidence,
    guarantees: evidenceGuarantees(context),
    targetId: suite.name,
    manifest: context.manifest, manifestHash: manifestHash(context.manifest),
    steps: [], blockedOrigins: keptOrigins(context), unavailable: null,
    suite: { name: suite.name, tests, findings, ...(audits.length === 0 ? {} : { accessibilityFindings: audits }) },
    evidence: { pass, exitCode, exitCodeMismatch, ...(outcomeCode === undefined ? {} : { outcomeCode }), ...(decodeErrors.length === 0 ? {} : { decodeErrors }) },
    ...(reviewItems.length === 0 ? {} : { reviewItems }),
    timings: { totalMilliseconds: report.tests.reduce((total, test) => total + test.durationMilliseconds, 0), stepMilliseconds: [] },
  });
}

// Why a suite run's report went unread that its context cannot say: its setup command failed, or
// the report is missing or was refused.
export type UnreadReportCode = typeof EvidenceOutcomeCode.SetupFailed | typeof EvidenceOutcomeCode.SuiteReportUnread;

// The context of a run whose setup command left no egress record, which is all that went wrong.
type EgressUnreadContext = EvidenceContext & { readonly egress: typeof RECORD_UNREAD };

// The result of a suite run whose report could not be read: it wrote none, or the decoder refused
// it, or its setup command failed first or left no egress record. It could not test, so it is
// Errored, with no tests. A run the runner stopped at its timeout says so, whatever else went wrong;
// otherwise the report's code, if any, stands before an unread egress record.
export function unreadSuiteResult(context: EgressUnreadContext): SuiteRanResult;
export function unreadSuiteResult(
  context: EvidenceContext, reportCode: UnreadReportCode, decodeErrors?: readonly SuiteDecodeError[],
): SuiteRanResult;
export function unreadSuiteResult(
  context: EvidenceContext, reportCode?: UnreadReportCode, decodeErrors: readonly SuiteDecodeError[] = [],
): SuiteRanResult {
  const { suite, pass, exitCode } = context;
  const outcomeCode = unreadOutcomeCode(context, reportCode);
  return withRunHashes({
    state: TerminalState.Errored,
    mode: RunMode.Evidence,
    guarantees: evidenceGuarantees(context),
    targetId: suite.name,
    manifest: context.manifest, manifestHash: manifestHash(context.manifest),
    steps: [], blockedOrigins: keptOrigins(context), unavailable: null,
    suite: { name: suite.name, tests: [], findings: [] },
    evidence: { pass, exitCode, exitCodeMismatch: false, outcomeCode, ...(decodeErrors.length === 0 ? {} : { decodeErrors }) },
    timings: { totalMilliseconds: 0, stepMilliseconds: [] },
  });
}

// The result of `run --suite` refused before any suite code ran. Its guarantee statement says
// egress was not enforced when that is why it was refused.
export function refusedSuiteResult(suiteName: string, refusal: SuiteRefusal): SuiteRefusedResult {
  // The state stays ahead of the mode and guarantees among the result's keys.
  const { state, ...nothingRan } = refusedResult(refusal, suiteName, 0);
  return withRunHashes({
    state,
    mode: RunMode.Evidence,
    guarantees: guaranteeStatement({
      mode: RunMode.Evidence, egressEnforced: refusal.code !== RefusalCode.EgressUnenforceable, unmaskedScreenshotsKept: false, unsafeFeatures: [],
    }),
    ...nothingRan,
  });
}

// True when an evidence result may open the merge gate: only a gating pass, which ran the
// protected branch's suite files, that passed with nothing left for a person to look at. A
// proposal pass ran the change's own tests, so it never does; nor does a plan run's result.
export const evidenceMergeGateOpen = (result: RunResult): boolean =>
  result.mode === RunMode.Evidence && result.state === TerminalState.Passed && result.evidence.pass === SuitePass.Gating
  && (result.reviewItems ?? []).length === 0;
