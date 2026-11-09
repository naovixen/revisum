import type { AiPlanner } from "@revisum/engine";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// A planner whose answer is nothing the plan parser could accept.
export function fakeAiPlanner(overrides: Partial<AiPlanner> = {}): Recorded<AiPlanner> {
    const defaults: Required<AiPlanner> = { propose: () => Promise.resolve({}) };
    return recordCalls({ ...defaults, ...overrides });
}
