// Public entry point of the engine: everything trusted. Callers and tests import from here only.
// The shared types and ports from contracts are re-exported, so the engine's API is complete on
// its own.
export * from '@revisum/contracts';
export { ENGINE_VERSION, schemaId } from './version.ts';
export * from './plan/plan-decoders.ts';
export * from './project/project-parser.ts';
export { assertBranded, planParser } from './plan/plan-parser.ts';
export { migratePlan, type CriterionMapping } from './plan/plan-migration.ts';
export { planJsonSchema, type JsonSchema } from './plan/plan-schema.ts';
export { parseAiText, type AiText } from './ai-text.ts';
export * from './coverage-study.ts';
export * from './logging.ts';
export { jsonLinesEventSink } from './event-sink.ts';
export * from './redaction.ts';
export * from './random.ts';
export * from './hashing.ts';
export * from './manifest.ts';
export * from './oracle.ts';
export * as lifecycle from './lifecycle.ts';
export * from './run.ts';
export * from './ai-planning.ts';
export * from './release-notes.ts';
