import { success, type ClipboardPort } from "@revisum/engine";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A session's clipboard with nothing on it.
export function fakeClipboardPort(overrides: Partial<ClipboardPort> = {}): Recorded<ClipboardPort> {
    const defaults: Required<ClipboardPort> = {
        readText: () => Promise.resolve(success("")),
    };
    return recordCalls({ ...defaults, ...overrides });
}
