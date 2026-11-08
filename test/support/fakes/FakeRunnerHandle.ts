import { GuaranteeLevel, success, type RunnerHandle } from "@revisum/engine";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A run on the host, with no egress decisions to show, whose commands all exit 0 silently.
export function fakeRunnerHandle(overrides: Partial<RunnerHandle> = {}): Recorded<RunnerHandle> {
    const defaults: Required<RunnerHandle> = {
        runId: "fake-run",
        egressEvents: () => [],
        proxyDecisions: () => [],
        rewritesApplied: () => [],
        exec: () => Promise.resolve(success({ exitCode: 0, stdout: "", stderr: "" })),
        guaranteeLevel: () => GuaranteeLevel.Host,
    };
    return recordCalls({ ...defaults, ...overrides });
}
