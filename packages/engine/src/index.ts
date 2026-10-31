// Public entry point of the engine: everything trusted. Callers and tests import from here only.
// The shared types and ports from contracts are re-exported, so the engine's API is complete on
// its own.
export * from '@revisum/contracts';
export { ENGINE_VERSION, schemaId } from './version.ts';
export * from './plan/plan-decoders.ts';
export * from './project/project-parser.ts';
export {
  loadTrustedProject, isTrustedFile, CODE_OWNERS_PATHS,
  type ChangeUnderTest, type LoadedProject, type ProjectLoadError, type Provenance, type TrustedFileReviewItem, type TrustedProject,
} from './project/trusted-project.ts';
export {
  approvalVerifier, unverified, type ApprovalVerifier, type ApprovalVerifierOptions, type VerifiedOutcome, type VerifierResult,
} from './approval/approval-verifier.ts';
export * from './approval/plan-standing.ts';
// Read by tools/check-deny-rules.ts, which checks this repository's own agent lock-down.
export { deniesRequiredActions, parseDenyRules } from './approval/approvers-file.ts';
export { policyGate, type PolicyGate, type PolicyGateOptions } from './policy/policy-gate.ts';
export { BUILT_IN_IRREVERSIBLE_PATTERNS } from './policy/irreversible-patterns.ts';
export { assertBranded, planParser } from './plan/plan-parser.ts';
export { unsafeConstructsOf, unsafeFeaturesOf, type UnsafeConstruct } from './plan/unsafe-features.ts';
export { enabledUnsafeFeatures } from './project/unsafe-feature-declarations.ts';
export { migratePlan, type CriterionMapping } from './plan/plan-migration.ts';
export { clockAdvanceMilliseconds, totalClockAdvanceMilliseconds } from './clock-advance.ts';
export { planJsonSchema, type JsonSchema } from './plan/plan-schema.ts';
export {
  readPlanText, readablePlanText, writePlanText,
  type DraftError, type NoReadableForm, type TextErrorCode, type TextPosition, type TextReading, type TextWarning,
} from './plan/readable/plan-text.ts';
export { writePlanJson } from './plan/plan-json.ts';
export { admitCoreDraft, admitDraft, type PlanParse } from './plan/plan-drafts.ts';
export { parseAiText, type AiText } from './ai-text.ts';
// The draft command's pure parts: the criteria it reads, the prompt it sends and the wire formats.
export { extractCriteria } from './drafting/spec-criteria.ts';
export { READABLE_GRAMMAR_VERSION, plannerPrompt } from './drafting/planner-prompt.ts';
export {
  ANTHROPIC_API_VERSION, MAXIMUM_PLANNER_REPLY_BYTES, PLANNER_TIMEOUT_MILLISECONDS, plannerReplyText, plannerRequestBody,
} from './drafting/planner-wire.ts';
export * from './coverage-study.ts';
export * from './logging.ts';
export { jsonLinesEventSink } from './event-sink.ts';
export * from './redaction.ts';
export { environmentSecretStore } from './secrets/secret-store.ts';
export { leakScanner } from './secrets/leak-scanner.ts';
// headerSecret wraps a secret in its header scheme, such as "Bearer <value>", still opaque.
export { SECRET_PLACEHOLDER, headerSecret } from './secrets/secret-values.ts';
export * from './random.ts';
export * from './hashing.ts';
export * from './manifest.ts';
export * from './oracle.ts';
export * as lifecycle from './lifecycle.ts';
export * from './run.ts';
export { adapterRegistry } from './target/adapter-registry.ts';
export { isRequiredTarget, targetFidelity, targetKind, targetProvider } from './target/target-defaults.ts';
export { testedOn } from './target/tested-on.ts';
export { unavailableTargetOutcome } from './target/unavailable-target-outcome.ts';
export {
  BROWSER_BUILD_INPUT, LOCKFILE_NAME, LOCKFILE_SCHEMA, checkPinnedBuild, hashExecutable, lock, lockToFile, lockfileText, parseLockfile, readLockfile,
} from './target/target-lock.ts';
export { buildServiceRequest, DEFAULT_CALL_TIMEOUT_MILLISECONDS, DEFAULT_MAXIMUM_RESPONSE_BYTES, type RequestBuildError } from './service-calls/service-request.ts';
export type { CallStepCode, CleanupResult, ServiceCallRecord } from './service-calls/call-steps.ts';
export { generateValue, resolvePlanClock, type RunValues, type StepErrorCode } from './run-values.ts';
export * from './ai-planning.ts';
export * from './release-notes.ts';
export { guaranteeStatement, type GuaranteeConditions } from './guarantees.ts';
export { DEFAULT_EVIDENCE_LIMITS, isReservedEnvironmentName } from './project/evidence-declarations.ts';
export { declaredSuite, isSuiteFile, suitePasses, type PlannedSuitePass } from './evidence/suite-choice.ts';
export {
  DEFAULT_REPORT_DEPTH, parseSuiteReport,
  type SuiteAnnotation, type SuiteAttachment, type SuiteDecodeError, type SuiteDecodeErrorCode, type SuiteErrorLocation, type SuiteReport,
  type SuiteReportError, type SuiteReportOptions, type SuiteReportTest, type SuiteTrace,
} from './evidence/suite-report.ts';
export { SUPPORTED_TRACE_VERSIONS, parseSuiteTrace } from './evidence/suite-trace.ts';
export { REPORT_PATH_VARIABLE, SUITE_REPORT_FILE, SUITE_RESULTS_FOLDER, suiteArguments, type SuiteArguments } from './evidence/suite-arguments.ts';
export { suiteEnvironment, suiteRedactor, type SuiteEnvironment } from './evidence/suite-environment.ts';
export {
  evidenceMergeGateOpen, evidenceResult, refusedSuiteResult, unreadSuiteResult, type EvidenceContext,
} from './evidence/evidence-result.ts';
