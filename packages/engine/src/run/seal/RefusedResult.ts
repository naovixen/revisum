import {
    TerminalState,
    type NothingRanFields,
    type PlanRefusedResult,
    type Refusal,
    type RunTimings,
    type TargetUnavailableResult,
    type Unavailable,
} from "@revisum/contracts";
import type { SealedFields } from "./SealResult.ts";

// A refused run's result before it is sealed, refused for this reason.
export type RefusedBeforeAnyStep<Why extends Refusal> = Omit<
    PlanRefusedResult,
    SealedFields | "refusal"
> & { readonly refusal: Why };

// A run's result before it is sealed when its target could not be opened.
export type UnavailableBeforeAnyStep = Omit<TargetUnavailableResult, SealedFields>;

// What a result says when a run ended before any step: no manifest and no step. Each result writes
// its reason between the empty fields and the timings, in its own key order, since a result's key
// order is published.
const nothingRanFields = (targetId: string): NothingRanFields & { readonly targetId: string } => ({
    targetId,
    manifest: null,
    manifestHash: null,
    steps: [],
    blockedOrigins: [],
});

const noStepTimings = (totalMilliseconds: number): RunTimings => ({
    totalMilliseconds,
    stepMilliseconds: [],
});

// What every refused run's result says: the refusal is the whole of the outcome. The caller adds
// the mode and guarantees of its kind of run.
export const refusedResult = <Why extends Refusal>(
    refusal: Why,
    targetId: string,
    totalMilliseconds: number,
): RefusedBeforeAnyStep<Why> => ({
    state: TerminalState.Refused,
    ...nothingRanFields(targetId),
    unavailable: null,
    refusal,
    timings: noStepTimings(totalMilliseconds),
});

// What a run's result says when its target could not be opened. The caller adds the mode and
// guarantees of its kind of run.
export const targetUnavailableResult = (
    unavailable: Unavailable,
    targetId: string,
    totalMilliseconds: number,
): UnavailableBeforeAnyStep => ({
    state: TerminalState.TargetUnavailable,
    ...nothingRanFields(targetId),
    unavailable,
    timings: noStepTimings(totalMilliseconds),
});
