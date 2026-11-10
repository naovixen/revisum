// The states a run can end in. A run that ran its steps ends Passed, Failed, Errored or Denied; one
// that never reached its steps ends TargetUnavailable or Refused.
export const TerminalState = {
    Passed: "Passed",
    Failed: "Failed",
    Errored: "Errored",
    Denied: "Denied",
    TargetUnavailable: "TargetUnavailable",
    Refused: "Refused",
} as const;

export type TerminalState = (typeof TerminalState)[keyof typeof TerminalState];
