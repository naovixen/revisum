import { GuaranteeLevel, failure, success, type RunnerHandle } from "@revisum/engine";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A handle a fake runner can end, as a real runner ends one when `use` returns: from then on its
// `exec` fails, whichever answer a test gave it, since the run's containers are gone.
export type EndableRunnerHandle = Recorded<RunnerHandle> & { end(): void };

// A run on the host, with no egress decisions to show, whose commands all exit 0 silently.
export function fakeRunnerHandle(overrides: Partial<RunnerHandle> = {}): EndableRunnerHandle {
    const exec =
        overrides.exec ?? (() => Promise.resolve(success({ exitCode: 0, stdout: "", stderr: "" })));
    let hasEnded = false;
    const defaults: Required<RunnerHandle> = {
        runId: "fake-run",
        egressEvents: () => [],
        proxyDecisions: () => [],
        rewritesApplied: () => [],
        guaranteeLevel: () => GuaranteeLevel.Host,
        ...overrides,
        exec: (command, environmentNames) =>
            hasEnded
                ? Promise.resolve(
                      failure({ detail: "the run has ended, so its containers are gone" }),
                  )
                : exec(command, environmentNames),
    };
    return recordCalls({
        ...defaults,
        end: () => {
            hasEnded = true;
        },
    });
}
