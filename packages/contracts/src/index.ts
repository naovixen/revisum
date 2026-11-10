// Public entry point: shared types, the plan language's types and the port interfaces that the
// engine, drivers, auditors and renderers agree on. No package logic lives here, apart from the
// opaque Secret wrapper, which drivers need without importing the engine, and how an origin's host
// and port read, which the driver and the runner must agree on.
export { PRODUCT } from "./product/Product.ts";
export type { Brand } from "./foundation/Brand.ts";
export { failure, success, type Failure, type Result, type Success } from "./foundation/Result.ts";
export * from "./ports/Target.ts";
export * from "./ports/WorkloadOutcomeKind.ts";
export * from "./plan/Plan.ts";
export * from "./plan/TextOrValue.ts";
export type * from "./plan/CriterionId.ts";
export type * from "./plan/FixtureName.ts";
export type * from "./plan/SecretName.ts";
export * from "./plan/StepType.ts";
export * from "./plan/Key.ts";
export * from "./plan/Role.ts";
export * from "./plan/PlanDraft.ts";
export * from "./plan/LiteralText.ts";
export * from "./ports/Secret.ts";
export * from "./foundation/UnwiredPort.ts";
export * from "./plan/steps/ServiceCaller.ts";
export * from "./plan/steps/NetworkAndStorageStep.ts";
export * from "./plan/steps/ClockAndClipboardStep.ts";
export * from "./modes/EvidenceMode.ts";
export * from "./plan/steps/UnsafeFeaturesDeclaration.ts";
export * from "./plan/UnsafeFeature.ts";
export * from "./ports/BrowserDriver.ts";
export * from "./errors/DriverError.ts";
export { hostAndPort } from "./foundation/HostAndPort.ts";
export { originOfUrl, parseOrigin } from "./foundation/ParseOrigin.ts";
export { mergeRefusedOrigins } from "./foundation/MergeRefusedOrigins.ts";
export type * from "./modes/PageMap.ts";
export { DraftWarningCode, ExploreErrorCode } from "./modes/PageMap.ts";
export type * from "./errors/TargetLockFailure.ts";
export { LockfileFailureCode } from "./errors/TargetLockFailure.ts";
export * from "./errors/ExitCode.ts";
export type * from "./ports/PolicyRuleId.ts";
export { PolicyRuleId, PolicyVerdictKind } from "./ports/PolicyRuleId.ts";
export type * from "./ports/ArtifactStore.ts";
export * from "./run-result/GuaranteeLevel.ts";
export type * from "./run-result/ArtifactReference.ts";
export type * from "./ports/Runner.ts";
export type * from "./plan/VariableName.ts";
export { BrowserChannel, EgressChannel, EgressDecision } from "./ports/Runner.ts";
export * from "./errors/ContainerRefusalCode.ts";
export * from "./ports/WorkloadRunner.ts";
export * from "./events/AuditEventKind.ts";
export type * from "./events/ActorId.ts";
export type * from "./ports/Approval.ts";
export {
    AccountType,
    AgentLockdownAction,
    ApprovalErrorCode,
    ApprovalLabel,
    ApprovalProofKind,
    ApprovalStrength,
    ApprovalSubjectKind,
    TrustErrorCode,
    VersionControlFailure,
    VersionControlReviewState,
} from "./ports/Approval.ts";
export type * from "./errors/RunnerError.ts";
export { RecorderErrorCode, RunnerErrorCode } from "./errors/RunnerError.ts";
export * from "./errors/CliErrorCode.ts";
export type * from "./run-result/RunRecord.ts";
export { ThresholdMetric } from "./run-result/RunRecord.ts";
export { isNonArrayObject } from "./foundation/IsNonArrayObject.ts";
export { isPlainObject } from "./foundation/IsPlainObject.ts";
export { StepCode } from "./foundation/StepCode.ts";
export { stepFailed, type StepFailure } from "./foundation/StepFailed.ts";
export { StepOutcome } from "./foundation/StepOutcome.ts";
export type * from "./run-result/CleanupResult.ts";
export type * from "./run-result/records/DatabaseCommandRecord.ts";
export type * from "./run-result/refusals/Denial.ts";
export type * from "./run-result/refusals/DeniedPlan.ts";
export type * from "./run-result/records/DownloadRecord.ts";
export * from "./run-result/EvidenceOutcomeCode.ts";
export type * from "./run-result/records/EvidenceRunRecord.ts";
export type * from "./run-result/records/PageScriptRecord.ts";
export * from "./run-result/refusals/PlanError.ts";
export * from "./run-result/refusals/Refusal.ts";
export * from "./run-result/refusals/Rejected.ts";
export type * from "./run-result/records/RememberedValueRecord.ts";
export * from "./run-result/RunManifest.ts";
export * from "./run-result/RunResult.ts";
export * from "./run-result/RunReviewItem.ts";
export type * from "./run-result/records/ServiceCallRecord.ts";
export type * from "./run-result/StepResult.ts";
export * from "./run-result/refusals/SuiteDecodeError.ts";
export type * from "./run-result/records/SuiteRunRecord.ts";
export * from "./run-result/TerminalState.ts";
export {
    CLOCK_CONTROLLER_KEY,
    determinismScript,
    virtualClockScript,
} from "./ports/DeterminismScript.ts";
