// What a run gives back, sealed: one shape per way a run can end, so each carries exactly the fields
// it can have. A plan run ran its steps (Passed, Failed or Errored), was denied by the policy gate's
// runtime guard, was refused before any driver call, found its target unavailable, or ended Errored
// when its driver broke its promise before any step. An evidence
// run ran its suite, or was refused before any suite code ran. Three plan shapes end Errored: a reader
// tells them apart by `denial`, which only the one that came from a denied run holds, and by `manifest`,
// which is null only on the one whose driver broke its promise before any step ran. The third, holding
// a manifest and no denial, ran its steps and ended Errored by itself.
import type { ApprovalLabel } from "../ports/Approval.ts";
import type { Unavailable } from "../ports/BrowserDriver.ts";
import type { GuaranteeStatement, RunMode } from "../modes/EvidenceMode.ts";
import type { StubAnswer } from "../plan/steps/NetworkAndStorageStep.ts";
import type { CleanupResult } from "./CleanupResult.ts";
import type { Denial } from "./refusals/Denial.ts";
import type { EvidenceRunRecord } from "./records/EvidenceRunRecord.ts";
import type { PlanRefusal, SuiteRefusal } from "./refusals/Refusal.ts";
import type { EvidenceRunManifest, PlanRunManifest } from "./RunManifest.ts";
import type { RunReviewItem } from "./RunReviewItem.ts";
import type { StepResult } from "./StepResult.ts";
import type { SuiteRunRecord } from "./records/SuiteRunRecord.ts";
import type { TerminalState } from "./TerminalState.ts";
import type { UnsafeFeature } from "../plan/UnsafeFeature.ts";

export type RunTimings = {
    readonly totalMilliseconds: number;
    readonly stepMilliseconds: readonly number[];
};

// What every result holds, however its run ended.
export type RunResultBasis = {
    // Which guarantees hold for this run, and why each lost one is lost.
    readonly guarantees: GuaranteeStatement;
    // An evidence run has no plan target: it carries its suite's name.
    readonly targetId: string;
    readonly blockedOrigins: readonly string[];
    // What replay compares: everything in the result except the manifest body, which its own hash
    // covers, and blockedOrigins, which a request sent as a run ends can change. Timings are excluded.
    readonly resultHash: string;
    // The same, with blockedOrigins covered, so an edit to that list shows against a copy held elsewhere.
    readonly evidenceHash: string;
    readonly timings: RunTimings;
};

// What a result says of a run that ended before any step: no manifest, no step and nothing refused.
export type NothingRanFields = {
    readonly manifest: null;
    readonly manifestHash: null;
    readonly steps: readonly [];
    readonly blockedOrigins: readonly [];
};

// What a plan run's result is labelled with as it is sealed.
export type PlanRunLabels = {
    readonly mode: typeof RunMode.Plan;
    // The unsafe features the run's plan uses: the run's unsafe label. Present only when there is one,
    // so a closed run's result and its hash stay exactly as they were.
    readonly unsafeFeatures?: readonly UnsafeFeature[];
    // Present when the plan is approved: what the result says about that approval.
    readonly approvalLabel?: ApprovalLabel;
};

// What a plan run that reached its steps records.
export type PlanStepsFields = {
    readonly manifest: PlanRunManifest;
    readonly manifestHash: string;
    readonly steps: readonly StepResult[];
    readonly unavailable: null;
    // Present when the plan has cleanup calls: one record per call, in order.
    readonly cleanup?: readonly CleanupResult[];
    // Present when the run raised something for a person to look at.
    readonly reviewItems?: readonly RunReviewItem[];
    // Present when a stub answered a request: which stub and which of its responses (counted from 1)
    // answered each, in the order they were answered.
    readonly stubAnswers?: readonly StubAnswer[];
};

// A plan run whose steps were not denied. An Errored one here holds no denial: an Errored run that
// came from a denied run is a PlanDeniedThenErroredResult.
export type PlanRanResult = RunResultBasis &
    PlanRunLabels &
    PlanStepsFields & {
        readonly state:
            | typeof TerminalState.Passed
            | typeof TerminalState.Failed
            | typeof TerminalState.Errored;
    };

// A plan run the policy gate's runtime guard stopped before an action.
export type PlanDeniedResult = RunResultBasis &
    PlanRunLabels &
    PlanStepsFields & {
        readonly state: typeof TerminalState.Denied;
        readonly denial: Denial;
    };

// A denied plan run that a record read after its steps left without a verdict, whichever record it
// was: it ends Errored, since it cannot show what it tested or that its egress was enforced, and
// always keeps its denial, since the guard did stop an action.
export type PlanDeniedThenErroredResult = RunResultBasis &
    PlanRunLabels &
    PlanStepsFields & {
        readonly state: typeof TerminalState.Errored;
        readonly denial: Denial;
    };

// A plan run refused before any driver call.
export type PlanRefusedResult = RunResultBasis &
    PlanRunLabels &
    NothingRanFields & {
        readonly state: typeof TerminalState.Refused;
        readonly unavailable: null;
        readonly refusal: PlanRefusal;
    };

// A plan run whose driver broke its promise of a Result before any step ran. That says nothing about
// the target, so the run ends Errored, with no step and no manifest.
export type PlanDriverBrokeResult = RunResultBasis &
    PlanRunLabels &
    NothingRanFields & {
        readonly state: typeof TerminalState.Errored;
        readonly unavailable: null;
    };

// A plan run whose target could not be opened, or is not declared.
export type TargetUnavailableResult = RunResultBasis &
    PlanRunLabels &
    NothingRanFields & {
        readonly state: typeof TerminalState.TargetUnavailable;
        readonly unavailable: Unavailable;
    };

// An evidence run that ran its suite, or tried to: what the suite reported, never verified evidence.
export type SuiteRanResult = RunResultBasis & {
    readonly mode: typeof RunMode.Evidence;
    readonly state:
        typeof TerminalState.Passed | typeof TerminalState.Failed | typeof TerminalState.Errored;
    readonly manifest: EvidenceRunManifest;
    readonly manifestHash: string;
    readonly steps: readonly [];
    readonly unavailable: null;
    readonly suite: SuiteRunRecord;
    readonly evidence: EvidenceRunRecord;
    // Present when the run raised something for a person to look at.
    readonly reviewItems?: readonly RunReviewItem[];
};

// An evidence run refused before any suite code ran.
export type SuiteRefusedResult = RunResultBasis &
    NothingRanFields & {
        readonly mode: typeof RunMode.Evidence;
        readonly state: typeof TerminalState.Refused;
        readonly unavailable: null;
        readonly refusal: SuiteRefusal;
    };

type EachShape =
    | PlanRanResult
    | PlanDeniedResult
    | PlanDeniedThenErroredResult
    | PlanRefusedResult
    | PlanDriverBrokeResult
    | TargetUnavailableResult
    | SuiteRanResult
    | SuiteRefusedResult;

type FieldOfAnyShape<Shapes> = Shapes extends unknown ? keyof Shapes : never;

// Each shape, with every field only another shape holds marked as never there, so a reader can ask
// any result for any field and gets nothing where its shape has none, while no shape can be built
// with another's field.
type WithOthersFieldsAbsent<
    Shapes,
    AllFields extends PropertyKey = FieldOfAnyShape<Shapes>,
> = Shapes extends unknown
    ? Shapes & { readonly [Field in Exclude<AllFields, keyof Shapes>]?: never }
    : never;

export type RunResult = WithOthersFieldsAbsent<EachShape>;

export type PlanRunResult = Extract<RunResult, { readonly mode: typeof RunMode.Plan }>;

export type EvidenceRunResult = Extract<RunResult, { readonly mode: typeof RunMode.Evidence }>;

// True for a plan run the policy gate's runtime guard stopped: a Denied one, or one a record read
// after its steps then left Errored, which an ordinary Errored run is not.
export const isDeniedRun = (
    result: PlanRunResult,
): result is Extract<PlanRunResult, { readonly denial: Denial }> => result.denial !== undefined;
