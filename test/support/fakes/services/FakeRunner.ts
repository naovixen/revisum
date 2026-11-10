import {
    success,
    type Result,
    type Runner,
    type RunnerError,
    type RunnerHandle,
} from "@revisum/engine";
import { fakeRunnerHandle, type EndableRunnerHandle } from "./FakeRunnerHandle.ts";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

type FakeRunFinal = {
    readonly guaranteeLevel: ReturnType<RunnerHandle["guaranteeLevel"]>;
    readonly proxyDecisions: ReturnType<RunnerHandle["proxyDecisions"]>;
    readonly rewritesApplied: ReturnType<RunnerHandle["rewritesApplied"]>;
};

// What a fake run gives back once `use` has ended: `use`'s value and the handle's last word, with the
// handle ended, so a fake run has the same life as a real one.
export async function fakeRunEnding<Value>(
    handle: EndableRunnerHandle,
    use: (run: RunnerHandle) => Promise<Value>,
): Promise<Result<{ readonly value: Value; readonly final: FakeRunFinal }, RunnerError>> {
    const value = await use(handle);
    handle.end();
    return success({
        value,
        final: {
            guaranteeLevel: handle.guaranteeLevel(),
            proxyDecisions: handle.proxyDecisions(),
            rewritesApplied: handle.rewritesApplied(),
        },
    });
}

// A runner that gives every run it is asked for a handle on the host, so it claims no isolation.
export function fakeRunner(overrides: Partial<Runner> = {}): Recorded<Runner> {
    const defaults: Required<Runner> = {
        withRun: (image, policy, use) => fakeRunEnding(fakeRunnerHandle(), use),
    };
    return recordCalls({ ...defaults, ...overrides });
}
