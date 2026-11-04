import type { LoggedEvent, RunEventSink } from "@revisum/engine";
import { memoryRunEventSink } from "../memory-ports.ts";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A run's event log, kept in memory and read back through the port's own read().
export const fakeRunEventSink = (overrides: Partial<RunEventSink> = {}): Recorded<RunEventSink> =>
    recordCalls({ ...memoryRunEventSink(), ...overrides });

// A log that keeps events as usual, but cannot write one that `isFailing` picks out.
export function fakeRunEventSinkFailingOn(
    isFailing: (event: LoggedEvent) => boolean,
): Recorded<RunEventSink> {
    const kept = memoryRunEventSink();
    return fakeRunEventSink({
        read: () => kept.read(),
        append(event) {
            if (isFailing(event)) {
                throw new Error("the log could not be written");
            }
            kept.append(event);
        },
    });
}
