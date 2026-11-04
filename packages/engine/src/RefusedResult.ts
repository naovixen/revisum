import type { Refusal } from "./lifecycle.ts";
import { nothingRanResult, type NothingRanFields } from "./NothingRanResult.ts";

// What every refused run's result says: the refusal is the whole of the outcome. The caller adds
// the mode and guarantees of its kind of run.
export const refusedResult = (
    refusal: Refusal,
    targetId: string,
    totalMilliseconds: number,
): NothingRanFields =>
    nothingRanResult("Refused", targetId, totalMilliseconds, { unavailable: null, refusal });
