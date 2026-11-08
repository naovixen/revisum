// The command, through exec as an argument vector, under its timeout.
import { success, type ExecOutcome, type Result, type WorkloadRequest } from "@revisum/contracts";
import type { ContainerEngine, EngineProblem } from "../container-engine.ts";
import type { ContainerScope } from "../ContainerScope.ts";
import { workloadRefused, type WorkloadRefusal } from "./WorkloadRefusal.ts";

export type CommandRun = { readonly printed: ExecOutcome; readonly hasTimedOut: boolean };

export async function runCommandUnderTimeout(
    scope: ContainerScope,
    engine: ContainerEngine,
    teamId: string,
    request: WorkloadRequest,
): Promise<Result<CommandRun, WorkloadRefusal>> {
    const execution = engine.exec(teamId, request.argv);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), request.timeoutMilliseconds);
    });
    const first = await Promise.race([execution.then(() => "finished" as const), timeout]);
    clearTimeout(timer);
    const hasTimedOut = first === "timed-out";
    if (hasTimedOut) {
        // Removing the container ends the command; what it printed until then is still returned.
        await scope.removeContainer(teamId);
    }
    const finished: Result<ExecOutcome, EngineProblem> = await execution;
    if (!finished.ok && !hasTimedOut) {
        return workloadRefused(
            "workload-start-failed",
            `the command could not be run: ${finished.error.detail}`,
        );
    }
    return success({
        printed: finished.ok ? finished.value : { exitCode: -1, stdout: "", stderr: "" },
        hasTimedOut,
    });
}
