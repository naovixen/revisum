import { success, type ClockPort } from "@revisum/engine";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// A session's virtual clock with no timers to fire: every advance succeeds.
export function fakeClockPort(overrides: Partial<ClockPort> = {}): Recorded<ClockPort> {
    const defaults: Required<ClockPort> = {
        advance: () => Promise.resolve(success(undefined)),
    };
    return recordCalls({ ...defaults, ...overrides });
}
