import type { LeakScanner } from "@revisum/engine";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// A scanner that finds nothing.
export function fakeLeakScanner(overrides: Partial<LeakScanner> = {}): Recorded<LeakScanner> {
    const defaults: Required<LeakScanner> = { scan: () => [] };
    return recordCalls({ ...defaults, ...overrides });
}
