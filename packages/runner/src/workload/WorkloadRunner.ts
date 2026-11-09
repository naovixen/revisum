// The workload runner: a team's own image, pinned by digest, runs one argument vector behind the
// isolated runner's egress proxy, on a network with no route out and the same hardening for every
// container. Unlike a plan run, a workload never falls back to the host level: suite code is the
// team's own, so egress must be shown enforced before any of its containers start. Its name lookups
// are forwarded to the proxy container, which answers none and records each, so a process that ignores
// the proxy is still seen. A database command's request names the one service its policy allows over
// TCP: the proxy relays that port and the team's container maps the service's name to the proxy.
import {
    WorkloadOutcomeKind, PRODUCT,
    failure,
    success,
    type Result,
    WorkloadErrorCode,
    type WorkloadOutcome,
    type WorkloadRequest,
    type WorkloadRunner,
} from "@revisum/contracts";
import { answeringEngine } from "../containers/AnsweringEngine.ts";
import { NetworkFailureKind, type ContainerEngine } from "../containers/ContainerEngine.ts";
import {
    NetworkKind,
    withContainerScope,
    type ContainerScope,
} from "../containers/ContainerScope.ts";
import { dependenciesVolumeFor } from "../containers/RunImageContainer.ts";
import { safeLog } from "../containers/SafeLog.ts";
import { capturedOutput } from "./output/CapturedOutput.ts";
import { checkWorkloadRequest, type CheckedWorkloadRequest } from "./CheckWorkloadRequest.ts";
import { pinWorkloadImages } from "./PinWorkloadImages.ts";
import { removeFromOutput } from "./output/RemoveFromOutput.ts";
import { runCommandUnderTimeout } from "./RunCommandUnderTimeout.ts";
import { showEgressControlled } from "./ShowEgressControlled.ts";
import { startTeamContainer } from "./team-container/StartTeamContainer.ts";
import { readWorkloadEgress } from "./ReadWorkloadEgress.ts";
import type { WorkloadLog, WorkloadRefusal } from "./WorkloadRefusal.ts";

export type { WorkloadLogEntry } from "./WorkloadRefusal.ts";

export type WorkloadRunnerOptions = {
    readonly engine: ContainerEngine;
    // Revisum's own files: the proxy's code and the seccomp profile.
    readonly repositoryRoot: string;
    // The host folder of the repository under test, mounted read-only.
    readonly checkout: string;
    // As for dockerRunner: the Docker volume of Linux dependencies for the proxy's code.
    readonly dependenciesVolume?: string | null;
    readonly log?: WorkloadLog;
};

type Outcome = Result<WorkloadOutcome, WorkloadErrorCode>;

type WorkloadTools = {
    readonly engine: ContainerEngine;
    readonly root: string;
    readonly checkout: string;
    readonly dependenciesVolume: string | null;
    readonly log: WorkloadLog;
};

// What runs inside the run's containers, in order: the team's container starts only once egress
// control has been shown, and the command only runs inside it.
async function runInScope(
    scope: ContainerScope,
    tools: WorkloadTools,
    checked: CheckedWorkloadRequest,
    runImage: string,
): Promise<Result<WorkloadOutcome, WorkloadRefusal>> {
    const { engine, log } = tools;
    const proxy = await showEgressControlled(scope, { ...tools, runImage }, checked);
    if (!proxy.ok) {
        return proxy;
    }
    const team = await startTeamContainer(scope, tools, checked, proxy.value);
    if (!team.ok) {
        return team;
    }
    const command = await runCommandUnderTimeout(scope, engine, team.value, checked);
    if (!command.ok) {
        return command;
    }
    const egress = await readWorkloadEgress(engine, proxy.value.id, checked, log);
    const ended = command.value;
    const records = {
        egressEvents: egress.events,
        ...(egress.isUnread ? { egressRecordUnread: true } : {}),
        stdout: capturedOutput(ended.printed.stdout, checked.outputLimit),
        stderr: capturedOutput(ended.printed.stderr, checked.outputLimit),
    };
    return success(
        ended.kind === WorkloadOutcomeKind.Exited
            ? { kind: WorkloadOutcomeKind.Exited, exitCode: ended.exitCode, ...records }
            : { kind: WorkloadOutcomeKind.TimedOut, stop: ended.stop, ...records },
    );
}

export function workloadRunner(options: WorkloadRunnerOptions): WorkloadRunner {
    const { repositoryRoot: root, checkout } = options;
    const engine = answeringEngine(options.engine);
    const log: WorkloadLog = safeLog(options.log ?? ((): void => undefined));
    const tools: WorkloadTools = {
        engine,
        root,
        checkout,
        log,
        dependenciesVolume: dependenciesVolumeFor(options.dependenciesVolume),
    };
    const refuse = (refusal: WorkloadRefusal): Outcome => {
        log(refusal);
        return failure(refusal.code);
    };

    async function run(request: WorkloadRequest): Promise<Outcome> {
        const checked = checkWorkloadRequest(request, checkout, root);
        if (!checked.ok) {
            return refuse(checked.error);
        }
        const runImage = await pinWorkloadImages(engine, checked.value);
        if (!runImage.ok) {
            return refuse(runImage.error);
        }
        const scoped = await withContainerScope(
            engine,
            {
                namePrefix: `${PRODUCT.name}-workload`,
                networkKinds: [NetworkKind.Internal],
                log: (entry) => {
                    log({ code: "notice", detail: entry.detail });
                },
            },
            (scope) => runInScope(scope, tools, checked.value, runImage.value),
        );
        if (!scoped.ok) {
            return refuse(
                scoped.error.kind === NetworkFailureKind.InternalRefused
                    ? {
                          code: WorkloadErrorCode.EgressUnenforceable,
                          detail: `Docker could not create a network with no route out: ${scoped.error.detail}`,
                      }
                    : {
                          code: WorkloadErrorCode.WorkloadStartFailed,
                          detail: `the run's network could not be made: ${scoped.error.detail}`,
                      },
            );
        }
        return scoped.value.ok ? scoped.value : refuse(scoped.value.error);
    }

    return {
        run,
        removeFromOutput: (removal) => removeFromOutput(engine, root, log, removal),
    };
}
