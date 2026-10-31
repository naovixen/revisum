// The closed error-code unions that have no other home yet. Each code has a heading in
// docs/errors.md, so the link errors#<code> explains it. Plan errors live beside the plan parser
// in engine; driver errors beside the driver ports; sink errors beside the event sink.
// See docs/specs/SPEC-27-shared-types-and-events.md.

// Why the isolated runner could not start a run.
export type RunnerError = { readonly code: 'image-missing' | 'image-digest-mismatch' | 'egress-unenforceable' | 'start-failed' };

// Why the review recorder did not record a decision.
export type RecorderError = { readonly code: 'no-reason' | 'unknown-item' | 'already-decided' | 'sink-failed' };

// Why a command-line invocation failed. Each maps to one exit status.
export type CliErrorCode =
  | 'usage' | 'config-invalid' | 'untrusted-source' | 'plan-rejected' | 'target-unavailable'
  | 'lock-download-failed' | 'lock-offline' | 'approval-refused' | 'replay-mismatch' | 'internal'
  // The draft command's planner: a local endpoint off the loopback interface, and a call that
  // failed on the network, at the egress proxy or with the planner's status.
  | 'planner-endpoint-not-loopback' | 'planner-call-failed';
