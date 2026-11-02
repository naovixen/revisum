// Public entry point of the engine: everything trusted. Callers and tests import from here only.
// The shared types and ports from contracts are re-exported, so the engine's API is complete on
// its own.
export * from '@revisum/contracts';
export { schemaId } from './version.ts';
export * from './plan/plan-decoders.ts';
export * from './project/project-parser.ts';
export { loadTrustedProject, isTrustedFile, type LoadedProject, type TrustedProject } from './project/trusted-project.ts';
export { approvalVerifier, unverified, type ApprovalVerifier } from './approval/approval-verifier.ts';
export * from './approval/plan-standing.ts';
// Read by tools/check-deny-rules.ts, which checks this repository's own agent lock-down.
export { deniesRequiredActions, parseDenyRules } from './approval/approvers-file.ts';
export { policyGate, type PolicyGate } from './policy/policy-gate.ts';
export { assertBranded, planParser } from './plan/plan-parser.ts';
export { unsafeFeaturesOf } from './plan/unsafe-features.ts';
export { clockAdvanceMilliseconds, totalClockAdvanceMilliseconds } from './clock-advance.ts';
export { planJsonSchema } from './plan/plan-schema.ts';
export { readPlanText, readablePlanText, writePlanText, type DraftError, type TextErrorCode, type TextReading } from './plan/readable/plan-text.ts';
export { writePlanJson } from './plan/plan-json.ts';
export { admitCoreDraft, admitDraft, type PlanParse } from './plan/plan-drafts.ts';
export { parseAiText, type AiText } from './ai-text.ts';
// The draft command's pure parts: the criteria it reads, the prompt it sends and the wire formats.
export { extractCriteria } from './drafting/spec-criteria.ts';
export { READABLE_GRAMMAR_VERSION, plannerPrompt } from './drafting/planner-prompt.ts';
export {
  ANTHROPIC_API_VERSION, MAXIMUM_PLANNER_REPLY_BYTES, PLANNER_TIMEOUT_MILLISECONDS, plannerReplyText, plannerRequestBody,
} from './drafting/planner-wire.ts';
// Explore mode's pure parts and its crawl: the page map, the crawl with the browser session
// injected, and the static locator check of a draft against the map.
export {
  MAXIMUM_EXPLORE_DEPTH, MAXIMUM_EXPLORE_PAGES, decodePageMap, pageMapEntry, pageMapReference, pageMapText, redactPageMap,
} from './drafting/page-map.ts';
export {
  DEFAULT_EXPLORE_DEPTH, DEFAULT_EXPLORE_PAGES, DEFAULT_PAGE_TIMEOUT_MILLISECONDS, crawlSite, exploreStartOrigin,
} from './drafting/site-crawl.ts';
export { checkDraftLocators } from './drafting/draft-locator-check.ts';
export { withDeclaredSecretRedaction } from './secrets/secret-resolution.ts';
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
// Replay from a manifest, and the recorded replies of calls and commands it feeds back.
export { decodeManifest } from './replay/manifest-decoder.ts';
export { recordingPorts } from './replay/run-recording.ts';
export { replay, type ReplayOutcome } from './replay/replay.ts';
export * from './oracle.ts';
export * as lifecycle from './lifecycle.ts';
export * from './run.ts';
export { adapterRegistry } from './target/adapter-registry.ts';
export { testedOn } from './target/tested-on.ts';
export { unavailableTargetOutcome } from './target/unavailable-target-outcome.ts';
export { hashExecutable, lock, lockToFile } from './target/target-lock.ts';
export { buildServiceRequest } from './service-calls/service-request.ts';
export { generateValue, resolvePlanClock, type RunValues, type StepErrorCode } from './run-values.ts';
export * from './ai-planning.ts';
export * from './release-notes.ts';
export { guaranteeStatement } from './guarantees.ts';
export { declaredSuite, isSuiteFile, suitePasses } from './evidence/suite-choice.ts';
export { parseSuiteReport, type SuiteDecodeError, type SuiteDecodeErrorCode, type SuiteReport, type SuiteTrace } from './evidence/suite-report.ts';
export { parseSuiteTrace } from './evidence/suite-trace.ts';
export { SUITE_REPORT_FILE, suiteArguments } from './evidence/suite-arguments.ts';
export { suiteEnvironment, suiteRedactor } from './evidence/suite-environment.ts';
export {
  evidenceMergeGateOpen, evidenceResult, refusedSuiteResult, unreadSuiteResult, type EvidenceContext,
} from './evidence/evidence-result.ts';
