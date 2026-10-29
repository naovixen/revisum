// Compile-time guarantee: every error-code union is closed, so a switch that forgets a code fails
// to compile. Type-checked by type-check.test.ts and by shared-types.test.ts, never run.
//
// For each union there are two switches:
//   - one that handles exactly the codes the spec lists. It compiles only if the union holds those
//     codes and no others: an unknown case label, or a code left over at `unreachable`, is an error;
//   - one that leaves a code out. Its @ts-expect-error line must stay an error.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import type { CliErrorCode, DriverErrorCode, RecorderError, RunnerError, ServiceCallErrorCode, SinkError } from '@revisum/contracts';
import type { PlanErrorCode, StepErrorCode, SuiteDecodeErrorCode, TextErrorCode } from '@revisum/engine';

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
    case 'misplaced_step': case 'unsafe_interpolation': case 'header_not_allowed':
    case 'command_not_allowed': case 'path_not_allowed': case 'unsafe_feature_disabled':
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
    case 'undefined_value': case 'position_not_allowed': case 'misplaced_step': case 'unsafe_interpolation':
    case 'header_not_allowed': case 'command_not_allowed': case 'path_not_allowed': case 'unsafe_feature_disabled':
      return 'plan rejected';
    default:
      // @ts-expect-error 'vacuous' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}

// ---- Readable text errors (declared beside the readable plan reader) ------------------------------
export function describeTextError(code: TextErrorCode): string {
  switch (code) {
    case 'unknown-statement': case 'bad-locator': case 'bad-string': case 'bad-indent': case 'missing-header':
    case 'duplicate-header': case 'no-criterion': case 'unknown-key-name': case 'too-large': case 'duplicate-key': case 'no-readable-form':
    case 'missing-unsafe-mark': case 'unneeded-unsafe-mark':
      return 'text rejected';
    default:
      return unreachable(code);
  }
}
export function describeTextErrorForgettingOne(code: TextErrorCode): string {
  switch (code) {
    case 'unknown-statement': case 'bad-locator': case 'bad-string': case 'bad-indent': case 'missing-header':
    case 'duplicate-header': case 'no-criterion': case 'too-large': case 'duplicate-key': case 'no-readable-form':
    case 'missing-unsafe-mark': case 'unneeded-unsafe-mark':
      return 'text rejected';
    default:
      // @ts-expect-error 'unknown-key-name' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}

// ---- Suite report and trace errors (declared in engine beside the evidence-mode decoders) ---------
export function describeSuiteDecodeError(code: SuiteDecodeErrorCode): string {
  switch (code) {
    case 'suite-report-missing': case 'suite-report-invalid': case 'suite-report-unsupported':
    case 'trace-invalid': case 'trace-unsupported': case 'too-large':
      return 'suite output refused';
    default:
      return unreachable(code);
  }
}
export function describeSuiteDecodeErrorForgettingOne(code: SuiteDecodeErrorCode): string {
  switch (code) {
    case 'suite-report-missing': case 'suite-report-invalid': case 'suite-report-unsupported':
    case 'trace-invalid': case 'too-large':
      return 'suite output refused';
    default:
      // @ts-expect-error 'trace-unsupported' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}

// ---- Step errors (decided by the engine at run time, declared beside the interpreter) -------------
export function describeStepError(code: StepErrorCode): string {
  switch (code) {
    case 'value-empty': case 'value-unsafe': case 'value-too-long': case 'state-not-exposed': case 'download-not-text':
    case 'request-not-seen':
      return 'step failed';
    default:
      return unreachable(code);
  }
}
export function describeStepErrorForgettingOne(code: StepErrorCode): string {
  switch (code) {
    case 'value-empty': case 'value-too-long': case 'state-not-exposed': case 'download-not-text': case 'request-not-seen':
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
    case 'policy-denied': case 'no-download': case 'download-too-large': case 'storage-origin-mismatch':
    case 'clock-runaway': case 'clipboard-unavailable': case 'target-crashed': case 'unsupported-step': case 'assertion-failed':
      return 'driver failed';
    default:
      return unreachable(code);
  }
}
export function describeDriverErrorForgettingOne(code: DriverErrorCode): string {
  switch (code) {
    case 'not-found': case 'ambiguous': case 'not-actionable': case 'timeout': case 'policy-denied':
    case 'no-download': case 'download-too-large': case 'storage-origin-mismatch': case 'clock-runaway': case 'clipboard-unavailable':
    case 'target-crashed': case 'unsupported-step': case 'assertion-failed':
      return 'driver failed';
    default:
      // @ts-expect-error 'navigation-failed' is not handled, so the code does not narrow to never
      return unreachable(code);
  }
}

// ---- Service call errors (the ServiceCaller port's codes, and the engine's while it calls) --------
export function describeServiceCallError(code: ServiceCallErrorCode): string {
  switch (code) {
    case 'response-not-json': case 'response-too-large': case 'field-missing': case 'service-unreachable':
    case 'call-timeout': case 'unexpected-status': case 'egress-blocked': case 'parameter-invalid': case 'cleanup-failed':
      return 'service call failed';
    default:
      return unreachable(code);
  }
}
export function describeServiceCallErrorForgettingOne(code: ServiceCallErrorCode): string {
  switch (code) {
    case 'response-not-json': case 'response-too-large': case 'field-missing': case 'service-unreachable':
    case 'call-timeout': case 'unexpected-status': case 'parameter-invalid': case 'cleanup-failed':
      return 'service call failed';
    default:
      // @ts-expect-error 'egress-blocked' is not handled, so the code does not narrow to never
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
