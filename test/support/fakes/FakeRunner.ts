import { GuaranteeLevel, success, type Runner } from "@revisum/engine";
import { fakeRunnerHandle } from "./FakeRunnerHandle.ts";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A runner that starts every run it is asked to, on the host, so it claims no isolation.
export function fakeRunner(overrides: Partial<Runner> = {}): Recorded<Runner> {
    const defaults: Required<Runner> = {
        start: () => Promise.resolve(success(fakeRunnerHandle())),
        guaranteeLevel: () => GuaranteeLevel.Host,
    };
    return recordCalls({ ...defaults, ...overrides });
}
