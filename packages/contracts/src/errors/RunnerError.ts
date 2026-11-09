// The closed error-code unions that have no other home yet. Each code has a heading in
// docs/errors.md, so the link errors#<code> explains it. Plan errors live beside the plan parser
// in engine; driver errors beside the driver ports; sink errors beside the event sink; the
// command line's in CliErrorCode.ts.
import { ContainerRefusalCode } from './ContainerRefusalCode.ts';

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
