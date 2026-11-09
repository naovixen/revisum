import type { AiWriter } from "@revisum/engine";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// A writer that suggests the draft back, unchanged.
export function fakeAiWriter(overrides: Partial<AiWriter> = {}): Recorded<AiWriter> {
    const defaults: Required<AiWriter> = {
        suggest: (draft) => Promise.resolve(draft),
    };
    return recordCalls({ ...defaults, ...overrides });
}
