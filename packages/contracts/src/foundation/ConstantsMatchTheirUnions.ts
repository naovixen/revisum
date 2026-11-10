// A constant object and the union it names are written apart, so nothing else ties them: a kind
// added to one alone would compile, and the constant's list would hold a kind no variant has. Every
// row fails to compile when its two sides stop holding the same values. Only types exist here.
import type { ApprovalProof, ApprovalProofKind } from "../ports/Approval.ts";
import type {
    DomRead,
    DomReadKind,
    DomValue,
    FillValue,
    FillValueKind,
} from "../ports/BrowserDriver.ts";
import type {
    ClipboardAssertion,
    ClipboardAssertionKind,
} from "../plan/steps/ClockAndClipboardStep.ts";
import type {
    RequestCount,
    RequestCountKind,
    ResponseAssertion,
    ResponseAssertionKind,
    StorageAssertion,
    StorageAssertionKind,
} from "../plan/steps/NetworkAndStorageStep.ts";
import type { PlannerEndpoint, PlannerEndpointKind } from "../plan/PlanDraft.ts";
import type {
    DomCheckKind,
    DomCheckWith,
    DownloadAssertion,
    DownloadAssertionKind,
    ElementAssertion,
    ElementAssertionKind,
    GeneratedValue,
    GeneratedValueKind,
    PageAssertion,
    PageAssertionKind,
    RememberElementRead,
    RememberSource,
    SemanticLocatorKind,
    SemanticLocatorWith,
    Step,
    StructuralLocatorKind,
    StructuralLocatorWith,
} from "../plan/Plan.ts";
import type { GuardVerdict, PolicyVerdictKind } from "../ports/PolicyRuleId.ts";
import type { Refusal, RefusalCode } from "../run-result/refusals/Refusal.ts";
import type { RunResult } from "../run-result/RunResult.ts";
import type { RunReviewItem, RunReviewItemCode } from "../run-result/RunReviewItem.ts";
import type { TerminalState } from "../run-result/TerminalState.ts";
import type {
    BackendAssertion,
    BackendAssertionKind,
    ParameterKind,
    ParameterType,
} from "../plan/steps/ServiceCaller.ts";
import type { SafeText } from "../plan/TextOrValue.ts";
import type { StepType } from "../plan/StepType.ts";
import type { WorkloadOutcome } from "../ports/WorkloadRunner.ts";
import type { WorkloadOutcomeKind } from "../ports/WorkloadOutcomeKind.ts";

type HoldSameValues<Constant, Union> = [Constant] extends [Union]
    ? [Union] extends [Constant]
        ? true
        : false
    : false;
type MustHold<Check extends true> = Check;
// The key of each variant, for a union told apart by which key it has rather than by a kind field.
type KeyOfEachVariant<Union> = Union extends unknown ? keyof Union : never;

export type ConstantsMatchTheirUnions = [
    MustHold<HoldSameValues<ApprovalProofKind, ApprovalProof["kind"]>>,
    MustHold<HoldSameValues<GeneratedValueKind, GeneratedValue["kind"]>>,
    MustHold<HoldSameValues<SemanticLocatorKind, SemanticLocatorWith<SafeText>["by"]>>,
    MustHold<HoldSameValues<StructuralLocatorKind, StructuralLocatorWith<SafeText>["by"]>>,
    MustHold<HoldSameValues<ElementAssertionKind, ElementAssertion["kind"]>>,
    MustHold<HoldSameValues<DomCheckKind, DomCheckWith<SafeText>["kind"]>>,
    MustHold<HoldSameValues<PageAssertionKind, PageAssertion["kind"]>>,
    MustHold<HoldSameValues<DownloadAssertionKind, DownloadAssertion["kind"]>>,
    MustHold<
        HoldSameValues<
            RememberElementRead,
            Extract<RememberSource, { readonly element: unknown }>["read"]
        >
    >,
    MustHold<HoldSameValues<StepType, Step["type"]>>,
    MustHold<HoldSameValues<WorkloadOutcomeKind, WorkloadOutcome["kind"]>>,
    MustHold<HoldSameValues<DomReadKind, DomRead["kind"]>>,
    MustHold<HoldSameValues<DomReadKind, DomValue["kind"]>>,
    MustHold<HoldSameValues<ClipboardAssertionKind, ClipboardAssertion["kind"]>>,
    MustHold<HoldSameValues<RequestCountKind, KeyOfEachVariant<RequestCount>>>,
    MustHold<HoldSameValues<ResponseAssertionKind, ResponseAssertion["kind"]>>,
    MustHold<HoldSameValues<StorageAssertionKind, StorageAssertion["kind"]>>,
    MustHold<HoldSameValues<PlannerEndpointKind, PlannerEndpoint["kind"]>>,
    MustHold<HoldSameValues<PolicyVerdictKind, GuardVerdict["kind"]>>,
    MustHold<HoldSameValues<ParameterKind, ParameterType["kind"]>>,
    MustHold<HoldSameValues<BackendAssertionKind, BackendAssertion["kind"]>>,
    MustHold<HoldSameValues<FillValueKind, FillValue["kind"]>>,
    MustHold<HoldSameValues<TerminalState, RunResult["state"]>>,
    MustHold<HoldSameValues<RefusalCode, Refusal["code"]>>,
    MustHold<HoldSameValues<RunReviewItemCode, RunReviewItem["code"]>>,
];
