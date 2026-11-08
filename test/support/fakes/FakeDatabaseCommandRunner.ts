import { success, type DatabaseCommandRunner } from "@revisum/engine";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A database that takes every command, says nothing and exits 0.
export function fakeDatabaseCommandRunner(
    overrides: Partial<DatabaseCommandRunner> = {},
): Recorded<DatabaseCommandRunner> {
    const defaults: Required<DatabaseCommandRunner> = {
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
    };
    return recordCalls({ ...defaults, ...overrides });
}
