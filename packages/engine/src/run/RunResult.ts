// What a run gives back: a sealed result, or the reason an untrusted plan never ran.
import type {
    A11yFinding,
    ApprovalLabel,
    GuaranteeStatement,
    PolicyRuleId,
    RunMode,
    SafeText,
    StubAnswer,
    SuiteFinding,
    SuiteName,
    SuitePass,
    SuiteTestId,
    SuiteTestResult,
    Unavailable,
    UnsafeFeature,
} from "@revisum/contracts";
import type { SuiteDecodeError } from "../evidence/suite-report.ts";
import type { Denial, Refusal, TerminalState } from "../lifecycle.ts";
import type { RunManifest } from "../manifest.ts";
import type { PlanError } from "../plan/plan-decoders.ts";
import type { CleanupResult } from "../service-calls/call-steps.ts";
import type { StepResult } from "./StepResult.ts";

export const EGRESS_UNREAD = "egress-unread";

// A record a plan run reads from the session once its steps have run, left unread: the request
// decisions the browser refused, what the egress proxy rewrote, or which stubs answered.
export const UnreadRecordCode = {
    Refusals: "refusals-unread",
    Rewrites: "rewrites-unread",
    StubAnswers: "stub-answers-unread",
} as const;

export type UnreadRecordCode = (typeof UnreadRecordCode)[keyof typeof UnreadRecordCode];

// Something a run found that a person should look at, whatever the verdict: a cleanup call that
// failed, so test data may be left behind; or a suite test's criterion annotation whose
// description is not a valid criterion id, so it was dropped (never echoed).
export type RunReviewItem =
    | { readonly code: "cleanup-failed"; readonly cleanupIndex: number }
    | {
          readonly code: "spec-ambiguous";
          readonly testId: SuiteTestId;
          readonly annotationIndex: number;
      }
    // A test the suite marked as expected to fail did fail: Playwright counts it as expected, but a
    // person should see why a failing test is kept.
    | { readonly code: "expected-failure"; readonly testId: SuiteTestId }
    // A project the suite declares has no test in the report, so what was tested is less than declared.
    | { readonly code: "project-without-tests"; readonly project: SafeText }
    // Part of the suite's output was refused (the run's decodeErrors, at this index), so the result
    // shows less than the suite recorded.
    | { readonly code: "suite-output-unread"; readonly decodeErrorIndex: number }
    // A plan run's egress could not say what it refused, so its empty blockedOrigins claims nothing and
    // the run ended Errored.
    | { readonly code: typeof EGRESS_UNREAD }
    // A plan run could not read one of the session's records after its steps, so the result does not
    // claim what it would have said. Without the refusals or the rewrites, the run ended Errored.
    | { readonly code: UnreadRecordCode };

// Why an evidence run ended as it did, beyond its tests' outcomes.
//   vacuous: the report holds no test that ran, so the run checked nothing and ends Failed.
//   suite-timeout: the suite ran past its timeout and was stopped; the run ends Errored.
//   setup-failed: the suite's setup command failed or timed out, so the suite never ran; Errored.
//   suite-report-unread: the suite's report is missing or was refused (decodeErrors says why); Errored.
//   egress-unread: what the egress proxy decided could not be read back, or not all of it was written,
//   so the run cannot show its egress was enforced; Errored.
export type EvidenceOutcomeCode =
    "vacuous" | "suite-timeout" | "setup-failed" | "suite-report-unread" | "egress-unread";

// What only an evidence run records: which pass it was, the suite command's exit code, and whether
// that code disagreed with the outcomes the report gives, which makes the run Errored. The outcome
// code and decode errors are present only when there are some, so other results stay as they were.
export type EvidenceRunRecord = {
    readonly pass: SuitePass;
    readonly exitCode: number;
    readonly exitCodeMismatch: boolean;
    readonly outcomeCode?: EvidenceOutcomeCode;
    // Codes and JSON paths only, never a value from the suite's output.
    readonly decodeErrors?: readonly SuiteDecodeError[];
};

// An evidence run's tests, one per test and project, and the findings its failed tests became.
export type SuiteRunRecord = {
    readonly name: SuiteName;
    readonly tests: readonly SuiteTestResult[];
    readonly findings: readonly SuiteFinding[];
    // Present when the recorded pages were audited.
    readonly accessibilityFindings?: readonly A11yFinding[];
};

export type RunResult = {
    readonly state: TerminalState;
    // How the run came about: a parsed plan, or a team's own suite in evidence mode.
    readonly mode: RunMode;
    // Which guarantees hold for this run, and why each lost one is lost.
    readonly guarantees: GuaranteeStatement;
    // The unsafe features the run's plan uses: the run's unsafe label. Present only when there is one,
    // so a closed run's result and its hash stay exactly as they were.
    readonly unsafeFeatures?: readonly UnsafeFeature[];
    // Present for an evidence run.
    readonly suite?: SuiteRunRecord;
    readonly evidence?: EvidenceRunRecord;
    // An evidence run has no plan target: it carries its suite's name.
    readonly targetId: string;
    readonly manifest: RunManifest | null;
    readonly manifestHash: string | null;
    readonly steps: readonly StepResult[];
    readonly blockedOrigins: readonly string[];
    readonly unavailable: Unavailable | null;
    // Present when the run was refused before any driver call.
    readonly refusal?: Refusal;
    // Present when the policy gate's runtime guard stopped the run before an action.
    readonly denial?: Denial;
    // Present when the plan is approved: what the result says about that approval.
    readonly approvalLabel?: ApprovalLabel;
    // Present when the plan has cleanup calls and its steps ran: one record per call, in order.
    readonly cleanup?: readonly CleanupResult[];
    // Present when the run raised something for a person to look at.
    readonly reviewItems?: readonly RunReviewItem[];
    // Present when a stub answered a request: which stub and which of its responses (counted from 1)
    // answered each, in the order they were answered.
    readonly stubAnswers?: readonly StubAnswer[];
    // What replay compares: everything above except the manifest body, which its own hash covers, and
    // blockedOrigins, which a request sent as a run ends can change. Timings are excluded.
    readonly resultHash: string;
    // The same, with blockedOrigins covered, so an edit to that list shows against a copy held elsewhere.
    readonly evidenceHash: string;
    readonly timings: {
        readonly totalMilliseconds: number;
        readonly stepMilliseconds: readonly number[];
    };
};

export type Rejected = { readonly state: "Rejected"; readonly errors: readonly PlanError[] };
// A parsed plan the policy gate's static check denied, so no run started. `unrecorded` is present
// when the audit sink failed to record the denial.
export type DeniedPlan = {
    readonly state: "Denied";
    readonly rule: PolicyRuleId;
    readonly stepIndex: number | null;
    readonly unrecorded?: true;
};
