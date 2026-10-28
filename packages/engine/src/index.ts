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
export { policyGate, type PolicyGate, type PolicyGateOptions } from './policy/policy-gate.ts';
export { BUILT_IN_IRREVERSIBLE_PATTERNS } from './policy/irreversible-patterns.ts';
export { assertBranded, planParser } from './plan/plan-parser.ts';
export { migratePlan, type CriterionMapping } from './plan/plan-migration.ts';
export { clockAdvanceMilliseconds, totalClockAdvanceMilliseconds } from './clock-advance.ts';
export { planJsonSchema, type JsonSchema } from './plan/plan-schema.ts';
export { parseAiText, type AiText } from './ai-text.ts';
export * from './coverage-study.ts';
export * from './logging.ts';
export { jsonLinesEventSink } from './event-sink.ts';
export * from './redaction.ts';
export { environmentSecretStore } from './secrets/secret-store.ts';
export { leakScanner } from './secrets/leak-scanner.ts';
export { SECRET_PLACEHOLDER } from './secrets/secret-values.ts';
export * from './random.ts';
export * from './hashing.ts';
export * from './manifest.ts';
export * from './oracle.ts';
export * as lifecycle from './lifecycle.ts';
export * from './run.ts';
export { buildServiceRequest, DEFAULT_CALL_TIMEOUT_MILLISECONDS, DEFAULT_MAXIMUM_RESPONSE_BYTES, type RequestBuildError } from './service-calls/service-request.ts';
export type { CallStepCode, CleanupResult, ServiceCallRecord } from './service-calls/call-steps.ts';
export { generateValue, resolvePlanClock, type RunValues, type StepErrorCode } from './run-values.ts';
export * from './ai-planning.ts';
export * from './release-notes.ts';
