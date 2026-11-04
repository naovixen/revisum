import type { Clock } from "@revisum/engine";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

export type FakeClock = Recorded<Clock> & { readonly elapsed: () => number };

// A clock that moves only when something sleeps on it, so waiting out a timeout costs no real time.
export function fakeClock(overrides: Partial<Clock> = {}): FakeClock {
    let time = 0;
    const defaults: Required<Clock> = {
        now: () => time,
        sleep: (milliseconds) => {
            time += Math.max(0, milliseconds);
            return Promise.resolve();
        },
    };
    return recordCalls({ ...defaults, ...overrides, elapsed: () => time });
}
