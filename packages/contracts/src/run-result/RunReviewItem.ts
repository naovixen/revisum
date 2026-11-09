import type { SuiteTestId } from "../modes/EvidenceMode.ts";
import { ServiceCallErrorCode } from "../plan/steps/ServiceCaller.ts";
import { EvidenceOutcomeCode } from "./EvidenceOutcomeCode.ts";
import type { SafeText } from "../plan/TextOrValue.ts";

// A record a plan run reads from the session once its steps have run, left unread: the request
// decisions the browser refused, what the egress proxy rewrote, or which stubs answered.
export const UnreadRecordCode = {
    Refusals: "refusals-unread",
    Rewrites: "rewrites-unread",
    StubAnswers: "stub-answers-unread",
} as const;

export type UnreadRecordCode = (typeof UnreadRecordCode)[keyof typeof UnreadRecordCode];

// Every code a run's review item can hold.
export const RunReviewItemCode = {
    CleanupFailed: ServiceCallErrorCode.CleanupFailed,
    SpecAmbiguous: "spec-ambiguous",
    ExpectedFailure: "expected-failure",
    ProjectWithoutTests: "project-without-tests",
    SuiteOutputUnread: "suite-output-unread",
    EgressUnread: EvidenceOutcomeCode.EgressUnread,
    ...UnreadRecordCode,
} as const;

export type RunReviewItemCode = (typeof RunReviewItemCode)[keyof typeof RunReviewItemCode];

// Something a run found that a person should look at, whatever the verdict.
export type RunReviewItem =
    // A cleanup call that failed, so test data may be left behind.
    | { readonly code: typeof RunReviewItemCode.CleanupFailed; readonly cleanupIndex: number }
    // A suite test's criterion annotation whose description is not a valid criterion id, so it was
    // dropped (never echoed).
    | {
          readonly code: typeof RunReviewItemCode.SpecAmbiguous;
          readonly testId: SuiteTestId;
          readonly annotationIndex: number;
      }
    // A test the suite marked as expected to fail did fail: Playwright counts it as expected, but a
    // person should see why a failing test is kept.
    | { readonly code: typeof RunReviewItemCode.ExpectedFailure; readonly testId: SuiteTestId }
    // A project the suite declares has no test in the report, so what was tested is less than declared.
    | { readonly code: typeof RunReviewItemCode.ProjectWithoutTests; readonly project: SafeText }
    // Part of the suite's output was refused (the run's decodeErrors, at this index), so the result
    // shows less than the suite recorded.
    | {
          readonly code: typeof RunReviewItemCode.SuiteOutputUnread;
          readonly decodeErrorIndex: number;
      }
    // A plan run's egress could not say what it refused, so its empty blockedOrigins claims nothing and
    // the run ended Errored.
    | { readonly code: typeof RunReviewItemCode.EgressUnread }
    // A plan run could not read one of the session's records after its steps, so the result does not
    // claim what it would have said. Without the refusals or the rewrites, the run ended Errored.
    | { readonly code: UnreadRecordCode };
