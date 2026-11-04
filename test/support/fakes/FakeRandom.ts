import type { Random } from "@revisum/engine";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// Randomness that always gives the same value, so a run on it can be repeated.
export function fakeRandom(overrides: Partial<Random> = {}): Recorded<Random> {
    const defaults: Required<Random> = { seed: 7, next: () => 0.5 };
    return recordCalls({ ...defaults, ...overrides });
}
