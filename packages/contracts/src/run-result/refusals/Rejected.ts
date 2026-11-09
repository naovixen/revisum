import type { PlanError } from "./PlanError.ts";

// The state of a plan the parser rejected, which no run reaches.
export const RejectedState = { Rejected: "Rejected" } as const;

export type RejectedState = (typeof RejectedState)[keyof typeof RejectedState];

// A plan the parser rejected, so no run started.
export type Rejected = {
    readonly state: typeof RejectedState.Rejected;
    readonly errors: readonly PlanError[];
};
