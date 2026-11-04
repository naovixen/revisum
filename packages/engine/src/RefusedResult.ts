import type { Refusal } from "./lifecycle.ts";
import type { RunResult } from "./run.ts";

type RefusedRunFields = Pick<
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

// What every refused run's result says: nothing ran, so there is no manifest and no step, and
// the refusal is the whole of the outcome. The caller adds the mode and guarantees of its kind of run.
export const refusedResult = (
    refusal: Refusal,
    targetId: string,
    totalMilliseconds: number,
): RefusedRunFields => ({
    state: "Refused",
    targetId,
    manifest: null,
    manifestHash: null,
    steps: [],
    blockedOrigins: [],
    unavailable: null,
    refusal,
    timings: { totalMilliseconds, stepMilliseconds: [] },
});
