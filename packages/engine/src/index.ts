// Public entry point of the engine: everything trusted. Callers and tests import from here only.
// The shared types and ports from contracts are re-exported, so the engine's API is complete on
// its own.
export * from "@revisum/contracts";
export { schemaId } from "./foundation/EngineVersion.ts";
export * from "./decoding/ReadRecord.ts";
export * from "./project/ParseProject.ts";
export {
    loadTrustedProject,
    isTrustedFile,
    type LoadedProject,
    type ProjectLoadError,
    type TrustedProject,
} from "./project/TrustedProject.ts";
export {
    approvalVerifier,
    unverified,
    type ApprovalVerifier,
} from "./approval/ApprovalVerifier.ts";
export * from "./approval/PlanStanding.ts";
// Read by tools/repo-rules/commits/CheckDenyRules.ts, which checks this repository's own agent lock-down.
export { deniesRequiredActions, parseDenyRules } from "./approval/ApproversFile.ts";
export type { ClearedRun } from "./policy/ClearedRun.ts";
export {
    policyGate,
    type PlanClearance,
    type PolicyGate,
    type RunClearance,
    type TargetClearance,
} from "./policy/PolicyGate.ts";
export type { TargetNotDeclared } from "./policy/TargetNotDeclared.ts";
export { BaseUrlRefusal, baseUrlOfOrigin, parseBaseUrl } from "./project/ParseBaseUrl.ts";
export { assertBranded, planParser } from "./plan/parse/PlanParser.ts";
export { unsafeFeaturesOf } from "./plan/UnsafeFeaturesOf.ts";
export {
    clockAdvanceMilliseconds,
    totalClockAdvanceMilliseconds,
} from "./run/executors/clock-and-clipboard/ClockAdvanceMilliseconds.ts";
export { planJsonSchema } from "./plan/schema/PlanJsonSchema.ts";
export {
    readPlanText,
    readablePlanText,
    writePlanText,
    type DraftError,
    type TextErrorCode,
    type TextPosition,
    type TextReading,
    type TextWarning,
} from "./plan/readable/ReadPlanText.ts";
export { writePlanJson } from "./plan/schema/WritePlanJson.ts";
export { admitCoreDraft, admitDraft, type PlanParse } from "./plan/parse/AdmitDraft.ts";
export { parseAiText, type AiText } from "./drafting/AiText.ts";
// The draft command's pure parts: the criteria it reads, the prompt it sends and the wire formats.
export { extractCriteria } from "./drafting/ExtractCriteria.ts";
export { READABLE_GRAMMAR_VERSION, plannerPrompt } from "./drafting/PlannerPrompt.ts";
export {
    ANTHROPIC_API_VERSION,
    MAXIMUM_PLANNER_REPLY_BYTES,
    PLANNER_TIMEOUT_MILLISECONDS,
    plannerReplyText,
    plannerRequestBody,
} from "./drafting/PlannerRequestBody.ts";
// Explore mode's pure parts and its crawl: the page map, the crawl with the browser session
// injected, and the static locator check of a draft against the map.
export {
    MAXIMUM_EXPLORE_DEPTH,
    MAXIMUM_EXPLORE_PAGES,
    decodePageMap,
    pageMapEntry,
    pageMapReference,
    pageMapText,
    redactPageMap,
} from "./drafting/PageMapEntry.ts";
export {
    DEFAULT_EXPLORE_DEPTH,
    DEFAULT_EXPLORE_PAGES,
    DEFAULT_PAGE_TIMEOUT_MILLISECONDS,
    crawlSite,
    exploreStartOrigin,
} from "./drafting/CrawlSite.ts";
export { checkDraftLocators } from "./drafting/CheckDraftLocators.ts";
export { withDeclaredSecretRedaction } from "./secrets/ResolvePlanSecrets.ts";
export * from "./run/logging/LoggingManifest.ts";
export { jsonLinesEventSink } from "./run/logging/JsonLinesEventSink.ts";
export * from "./secrets/DefaultRedactor.ts";
export { environmentSecretStore } from "./secrets/EnvironmentSecretStore.ts";
export { leakScanner } from "./secrets/LeakScanner.ts";
// headerSecret wraps a secret in its header scheme, such as "Bearer <value>", still opaque.
export { SECRET_PLACEHOLDER, headerSecret } from "./secrets/SecretRedaction.ts";
export * from "./foundation/SeededRandom.ts";
export * from "./foundation/Sha256.ts";
export * from "./run/seal/BuildManifest.ts";
// Replay from a manifest, and the recorded replies of calls and commands it feeds back.
export { decodeManifest } from "./replay/DecodeManifest.ts";
export { recordingPorts } from "./replay/RunRecording.ts";
export {
    replay,
    type ReplayError,
    type ReplayOutcome,
    type ReplayPorts,
    type ReplayRequest,
} from "./replay/Replay.ts";
export * from "./run/outcome/Verdict.ts";
export * as lifecycle from "./run/outcome/Transition.ts";
export { createRunService, type RunService } from "./run/RunService.ts";
export {
    emptySecretStore,
    noDatabaseCommandRunner,
    noRewrites,
    noServiceCaller,
    unwiredPorts,
} from "./run/UnwiredPorts.ts";
export { UntrustedRunOutcomeKind, type UntrustedRunOutcome } from "./run/RunUntrusted.ts";
export type { RunInputs, RunPorts } from "./run/RunContext.ts";
export { adapterRegistry } from "./target/AdapterRegistry.ts";
export { testedOn } from "./target/TestedOn.ts";
export { unavailableTargetOutcome } from "./target/UnavailableTargetOutcome.ts";
export { hashExecutable, lock, lockToFile, readLockfile } from "./target/ReadLockfile.ts";
export { buildServiceRequest } from "./run/executors/service-calls/BuildServiceRequest.ts";
export {
    generateValue,
    resolveLiteralActionStep,
    resolveLiteralLocator,
    resolvePlanClock,
    type RunValues,
    type StepErrorCode,
} from "./run/values/RunValues.ts";
export * from "./drafting/PlanWithAi.ts";
export * from "./evidence/WriteReleaseNotes.ts";
export { HOST_ISOLATION, guaranteeStatement } from "./run/seal/GuaranteeStatement.ts";
export { declaredSuite, isSuiteFile, suitePasses } from "./evidence/SuitePasses.ts";
export { parseSuiteReport, type SuiteReport, type SuiteTrace } from "./evidence/SuiteReport.ts";
export { parseSuiteTrace } from "./evidence/ParseSuiteTrace.ts";
export {
    SUITE_EVIDENCE_PATHS,
    SUITE_REPORT_FILE,
    suiteArguments,
} from "./evidence/SuiteArguments.ts";
export { suiteEnvironment, suiteRedactor } from "./evidence/SuiteEnvironment.ts";
export {
    evidenceMergeGateOpen,
    evidenceResult,
    refusedSuiteResult,
    unreadSuiteResult,
    type EvidenceContext,
    type UnreadReportCode,
} from "./evidence/EvidenceResult.ts";
export {
    RECORD_UNREAD,
    RecordReadKind,
    readValueOr,
    recordRead,
    type RecordRead,
} from "./run/after-the-verdict/RecordRead.ts";
