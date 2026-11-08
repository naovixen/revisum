// The command, through exec as an argument vector, under its timeout. A command that outlives it is
// stopped by removing its container, and the wait for that to end the command is bounded, so a daemon
// that never answers cannot hold the run open.
import { WorkloadStop, success, type ExecOutcome, type Result } from "@revisum/contracts";
import { adapterAnswer, type ProblemDetail } from "../AdapterAnswer.ts";
import type { ContainerEngine } from "../container-engine.ts";
import type { ContainerScope } from "../ContainerScope.ts";
import type { CheckedWorkloadRequest } from "./CheckWorkloadRequest.ts";
import { workloadRefused, type WorkloadRefusal } from "./WorkloadRefusal.ts";

// How long a stopped command's end is waited for, once its timeout has passed.
const STOPPED_COMMAND_WAIT_MILLISECONDS = 10_000;

type Printed = Pick<ExecOutcome, "stdout" | "stderr">;

const NOTHING_PRINTED: Printed = { stdout: "", stderr: "" };

export type CommandEnd =
    | { readonly kind: "exited"; readonly exitCode: number; readonly printed: Printed }
    | { readonly kind: "timed-out"; readonly stop: WorkloadStop; readonly printed: Printed };

type Timer = { readonly elapsed: Promise<"elapsed">; cancel(): void };

function timerOf(milliseconds: number): Timer {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<"elapsed">((resolve) => {
        handle = setTimeout(() => resolve("elapsed"), milliseconds);
    });
    return { elapsed, cancel: () => clearTimeout(handle) };
}

type CommandAnswer = Result<ExecOutcome, ProblemDetail>;

// What became of a command the timeout stopped. Removing its container ends it, and what it printed
// until then is still returned.
async function stopped(
    scope: ContainerScope,
    teamId: string,
    execution: Promise<CommandAnswer>,
): Promise<Extract<CommandEnd, { kind: "timed-out" }>> {
    const progress: { removal: Result<void, ProblemDetail> | null; ended: CommandAnswer | null } = {
        removal: null,
        ended: null,
    };
    const removing = scope.removeContainer(teamId).then((removal) => {
        progress.removal = removal;
    });
    const ending = execution.then((ended) => {
        progress.ended = ended;
    });
    const wait = timerOf(STOPPED_COMMAND_WAIT_MILLISECONDS);
    await Promise.race([Promise.all([removing, ending]), wait.elapsed]);
    wait.cancel();
    const { removal, ended } = progress;
    if (removal === null || !removal.ok) {
        return { kind: "timed-out", stop: WorkloadStop.RemovalFailed, printed: printedBy(ended) };
    }
    return {
        kind: "timed-out",
        stop: ended === null ? WorkloadStop.CommandNeverSettled : WorkloadStop.Removed,
        printed: printedBy(ended),
    };
}

const printedBy = (ended: CommandAnswer | null): Printed =>
    ended?.ok === true ? ended.value : NOTHING_PRINTED;

export async function runCommandUnderTimeout(
    scope: ContainerScope,
    engine: ContainerEngine,
    teamId: string,
    checked: CheckedWorkloadRequest,
): Promise<Result<CommandEnd, WorkloadRefusal>> {
    const execution = adapterAnswer(() => engine.exec(teamId, checked.argv));
    const timeout = timerOf(checked.timeoutMilliseconds);
    const first = await Promise.race([execution, timeout.elapsed]);
    timeout.cancel();
    if (first === "elapsed") {
        return success(await stopped(scope, teamId, execution));
    }
    if (!first.ok) {
        return workloadRefused(
            "workload-start-failed",
            `the command could not be run: ${first.error.detail}`,
        );
    }
    return success({ kind: "exited", exitCode: first.value.exitCode, printed: first.value });
}
