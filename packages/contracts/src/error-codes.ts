// The closed error-code unions that have no other home yet. Each code has a heading in
// docs/errors.md, so the link errors#<code> explains it. Plan errors live beside the plan parser
// in engine; driver errors beside the driver ports; sink errors beside the event sink.
import { TrustErrorCode } from './approval.ts';
import { BuildFetchFailureCode } from './browser-driver.ts';
import { ExploreErrorCode } from './explore-mode.ts';
import { ContainerRefusalCode } from './isolated-runner.ts';

// Why the isolated runner could not start a run.
export const RunnerErrorCode = {
  ...ContainerRefusalCode,
  StartFailed: 'start-failed',
} as const;
export type RunnerErrorCode = (typeof RunnerErrorCode)[keyof typeof RunnerErrorCode];
export type RunnerError = { readonly code: RunnerErrorCode };

// Why the review recorder did not record a decision.
export const RecorderErrorCode = {
  NoReason: 'no-reason',
  UnknownItem: 'unknown-item',
  AlreadyDecided: 'already-decided',
  SinkFailed: 'sink-failed',
} as const;
export type RecorderErrorCode = (typeof RecorderErrorCode)[keyof typeof RecorderErrorCode];
export type RecorderError = { readonly code: RecorderErrorCode };

// Why a command-line invocation failed. Each maps to one exit status.
export const CliErrorCode = {
  Usage: 'usage',
  ConfigInvalid: 'config-invalid',
  UntrustedSource: TrustErrorCode.UntrustedSource,
  PlanRejected: 'plan-rejected',
  TargetUnavailable: 'target-unavailable',
  ...BuildFetchFailureCode,
  ApprovalRefused: 'approval-refused',
  ReplayMismatch: 'replay-mismatch',
  Internal: 'internal',
  // The draft command's planner and its explore mode.
  ...ExploreErrorCode,
} as const;
export type CliErrorCode = (typeof CliErrorCode)[keyof typeof CliErrorCode];
