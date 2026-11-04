import type { Unavailable } from "@revisum/contracts";
import type { Refusal } from "./lifecycle.ts";
import type { RunResult } from "./run.ts";

export type NothingRanResult = Pick<
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
const nothingRan = (
    state: RunResult["state"],
    targetId: string,
    totalMilliseconds: number,
    why: Pick<RunResult, "unavailable" | "refusal">,
): NothingRanResult => ({
    state,
    targetId,
    manifest: null,
    manifestHash: null,
    steps: [],
    blockedOrigins: [],
    ...why,
    timings: { totalMilliseconds, stepMilliseconds: [] },
});

// What every refused run's result says: the refusal is the whole of the outcome. The caller adds
// the mode and guarantees of its kind of run.
export const refusedResult = (
    refusal: Refusal,
    targetId: string,
    totalMilliseconds: number,
): NothingRanResult =>
    nothingRan("Refused", targetId, totalMilliseconds, { unavailable: null, refusal });

// What a run's result says when its target could not be opened. The caller adds the mode and
// guarantees of its kind of run.
export const targetUnavailableResult = (
    unavailable: Unavailable,
    targetId: string,
    totalMilliseconds: number,
): NothingRanResult =>
    nothingRan("TargetUnavailable", targetId, totalMilliseconds, { unavailable });
