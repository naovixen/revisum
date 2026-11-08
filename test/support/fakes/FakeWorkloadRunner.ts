import { success, type WorkloadRunner } from "@revisum/engine";
import { leaveOut, type OptionalMember } from "./LeaveOut.ts";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A workload that says nothing and exits 0.
export function fakeWorkloadRunner(
    overrides: Partial<WorkloadRunner> = {},
    without: readonly OptionalMember<WorkloadRunner>[] = [],
): Recorded<WorkloadRunner> {
    const defaults: Required<WorkloadRunner> = {
        run: () =>
            Promise.resolve(
                success({
                    kind: "exited",
                    exitCode: 0,
                    egressEvents: [],
                    stdout: { bytes: new Uint8Array(), truncated: false },
                    stderr: { bytes: new Uint8Array(), truncated: false },
                }),
            ),
        removeFromOutput: () => Promise.resolve(),
    };
    return recordCalls(leaveOut<WorkloadRunner>({ ...defaults, ...overrides }, without));
}
