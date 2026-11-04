import type { EventSink } from "@revisum/engine";
import { memoryEventSink, type MemoryEventSink } from "../memory-ports.ts";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// An audit sink that keeps every event in `recorded`.
export function fakeEventSink(overrides: Partial<EventSink> = {}): Recorded<MemoryEventSink> {
    const defaults: MemoryEventSink & Required<EventSink> = memoryEventSink();
    return recordCalls({ ...defaults, ...overrides });
}
