import type { RunResult } from "./run.ts";

export type NothingRanFields = Pick<
    RunResult,
    | "state"
    | "targetId"
    | "manifest"
    | "manifestHash"
    | "steps"
    | "blockedOrigins"
    | "unavailable"
    | "refusal"
    | "timings"
>;

// What a result says when a run ended before any step: no manifest and no step. `why` is written
// between the empty fields and the timings, in its own key order, since a result's key order is
// published.
export const nothingRanResult = (
    state: RunResult["state"],
    targetId: string,
    totalMilliseconds: number,
    why: Pick<RunResult, "unavailable" | "refusal">,
): NothingRanFields => ({
    state,
    targetId,
    manifest: null,
    manifestHash: null,
    steps: [],
    blockedOrigins: [],
    ...why,
    timings: { totalMilliseconds, stepMilliseconds: [] },
});
