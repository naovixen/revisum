// Public entry point: shared types, the plan language's types and the port interfaces that the
// engine, drivers, auditors and renderers agree on. No package logic lives here, apart from the
// opaque Secret wrapper, which drivers need without importing the engine.
export { PRODUCT } from './product.ts';
export type { Brand } from './brand.ts';
export { failure, success, type Failure, type Result, type Success } from './result.ts';
export * from './target.ts';
export * from './plan.ts';
export * from './plan-drafts.ts';
export * from './literal-steps.ts';
export * from './secret.ts';
export * from './service-calls.ts';
export * from './network-and-storage.ts';
export * from './clock-and-clipboard.ts';
export * from './evidence-mode.ts';
export * from './browser-driver.ts';
export type * from './policy.ts';
export type * from './run-ports.ts';
export * from './audit-events.ts';
export type * from './approval.ts';
export type * from './error-codes.ts';
export type * from './run-history.ts';
export { NO_MOTION_CSS, determinismScript } from './determinism.ts';
