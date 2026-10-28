// Compile-time guarantee: every error-code union is closed, so a switch that forgets a code fails
// to compile. Type-checked by type-check.test.ts and by shared-types.test.ts, never run.
//
// For each union there are two switches:
//   - one that handles exactly the codes the spec lists. It compiles only if the union holds those
//     codes and no others: an unknown case label, or a code left over at `unreachable`, is an error;
//   - one that leaves a code out. Its @ts-expect-error line must stay an error.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import type { CliErrorCode, DriverErrorCode, RecorderError, RunnerError, SinkError } from '@revisum/contracts';
import type { PlanErrorCode, StepErrorCode } from '@revisum/engine';

// Only a value of type never may reach this, so every code must have been handled before it.
const unreachable = (code: never): never => {
  throw new Error(`unhandled error code ${String(code)}`);
};

// ---- Plan errors (declared in engine beside the parser) -----------------------------------------
export function describePlanError(code: PlanErrorCode): string {
  switch (code) {
    case 'not_object': case 'unknown_field': case 'missing_field': case 'wrong_type': case 'unknown_step':
    case 'unknown_value': case 'invalid_url': case 'scheme_not_allowed': case 'origin_not_allowed':
    case 'target_not_in_matrix': case 'unsafe_text': case 'too_large': case 'too_long': case 'duplicate':
    case 'version_unsupported': case 'empty': case 'vacuous':
    case 'no_criterion_id': case 'literal_secret': case 'undefined_value': case 'position_not_allowed':
    case 'misplaced_step':
      return 'plan rejected';
    default:
      return unreachable(code);
  }
}
export function describePlanErrorForgettingOne(code: PlanErrorCode): string {
  switch (code) {
    case 'not_object': case 'unknown_field': case 'missing_field': case 'wrong_type': case 'unknown_step':
    case 'unknown_value': case 'invalid_url': case 'scheme_not_allowed': case 'origin_not_allowed':
    case 'target_not_in_matrix': case 'unsafe_text': case 'too_large': case 'too_long': case 'duplicate':
    case 'version_unsupported': case 'empty': case 'no_criterion_id': case 'literal_secret':
    case 'undefined_value': case 'position_not_allowed': case 'misplaced_step':
      return 'plan rejected';
    default:
      // @ts-expect-error 'vacuous' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}

// ---- Step errors (decided by the engine at run time, declared beside the interpreter) -------------
export function describeStepError(code: StepErrorCode): string {
  switch (code) {
    case 'value-empty': case 'value-unsafe': case 'value-too-long': case 'state-not-exposed': case 'download-not-text':
      return 'step failed';
    default:
      return unreachable(code);
  }
}
export function describeStepErrorForgettingOne(code: StepErrorCode): string {
  switch (code) {
    case 'value-empty': case 'value-too-long': case 'state-not-exposed': case 'download-not-text':
      return 'step failed';
    default:
      // @ts-expect-error 'value-unsafe' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}

// ---- Driver errors ------------------------------------------------------------------------------
export function describeDriverError(code: DriverErrorCode): string {
  switch (code) {
    case 'not-found': case 'ambiguous': case 'not-actionable': case 'timeout': case 'navigation-failed':
    case 'policy-denied': case 'no-download': case 'download-too-large':
      return 'driver failed';
    default:
      return unreachable(code);
  }
}
export function describeDriverErrorForgettingOne(code: DriverErrorCode): string {
  switch (code) {
    case 'not-found': case 'ambiguous': case 'not-actionable': case 'timeout': case 'policy-denied':
    case 'no-download': case 'download-too-large':
      return 'driver failed';
    default:
      // @ts-expect-error 'navigation-failed' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}

// ---- Runner errors ------------------------------------------------------------------------------
export function describeRunnerError(code: RunnerError['code']): string {
  switch (code) {
    case 'image-missing': case 'image-digest-mismatch': case 'egress-unenforceable': case 'start-failed':
      return 'runner failed';
    default:
      return unreachable(code);
  }
}
export function describeRunnerErrorForgettingOne(code: RunnerError['code']): string {
  switch (code) {
    case 'image-missing': case 'image-digest-mismatch': case 'start-failed':
      return 'runner failed';
    default:
      // @ts-expect-error 'egress-unenforceable' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}

// ---- Review recorder errors ---------------------------------------------------------------------
export function describeRecorderError(code: RecorderError['code']): string {
  switch (code) {
    case 'no-reason': case 'unknown-item': case 'already-decided': case 'sink-failed':
      return 'decision not recorded';
    default:
      return unreachable(code);
  }
}
export function describeRecorderErrorForgettingOne(code: RecorderError['code']): string {
  switch (code) {
    case 'no-reason': case 'unknown-item': case 'sink-failed':
      return 'decision not recorded';
    default:
      // @ts-expect-error 'already-decided' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}

// ---- Event sink errors --------------------------------------------------------------------------
export function describeSinkError(code: SinkError['code']): string {
  switch (code) {
    case 'not-append-only': case 'write-failed':
      return 'event not written';
    default:
      return unreachable(code);
  }
}
export function describeSinkErrorForgettingOne(code: SinkError['code']): string {
  switch (code) {
    case 'write-failed':
      return 'event not written';
    default:
      // @ts-expect-error 'not-append-only' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}

// ---- Command-line errors ------------------------------------------------------------------------
export function describeCliError(code: CliErrorCode): string {
  switch (code) {
    case 'usage': case 'config-invalid': case 'untrusted-source': case 'plan-rejected': case 'target-unavailable':
    case 'lock-download-failed': case 'lock-offline': case 'approval-refused': case 'replay-mismatch': case 'internal':
      return 'command failed';
    default:
      return unreachable(code);
  }
}
export function describeCliErrorForgettingOne(code: CliErrorCode): string {
  switch (code) {
    case 'usage': case 'config-invalid': case 'untrusted-source': case 'plan-rejected': case 'target-unavailable':
    case 'lock-download-failed': case 'lock-offline': case 'approval-refused': case 'replay-mismatch':
      return 'command failed';
    default:
      // @ts-expect-error 'internal' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}
