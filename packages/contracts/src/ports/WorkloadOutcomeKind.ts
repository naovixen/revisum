// How a workload ended: it exited by itself, or the runner stopped it at its timeout.
export const WorkloadOutcomeKind = {
    Exited: "exited",
    TimedOut: "timed-out",
} as const;

export type WorkloadOutcomeKind = (typeof WorkloadOutcomeKind)[keyof typeof WorkloadOutcomeKind];
