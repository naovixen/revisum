import type { DraftPlanner } from "@revisum/engine";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// A planner whose reply holds no text, so no draft can come of it.
export function fakeDraftPlanner(overrides: Partial<DraftPlanner> = {}): Recorded<DraftPlanner> {
    const defaults: Required<DraftPlanner> = { draft: () => Promise.resolve({}) };
    return recordCalls({ ...defaults, ...overrides });
}
