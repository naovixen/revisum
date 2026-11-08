import { success, type Runner } from "@revisum/engine";
import { fakeRunnerHandle } from "./FakeRunnerHandle.ts";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A runner that gives every run it is asked for a handle on the host, so it claims no isolation.
export function fakeRunner(overrides: Partial<Runner> = {}): Recorded<Runner> {
    const defaults: Required<Runner> = {
        withRun: async (image, policy, use) => success(await use(fakeRunnerHandle())),
    };
    return recordCalls({ ...defaults, ...overrides });
}
