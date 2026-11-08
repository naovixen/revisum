// Compile-time guarantees of the runners' lifecycle. Type-checked by type-check.test.ts, never run:
// each @ts-expect-error line must stay an error, and tsc reports one that compiles.
//   - An engine is complete: omitting any member fails to compile, and removals answer a Result.
//   - A scope's network exists before anything can start in it: a scope has no way to make one,
//     and only asks for what a runner uses.
//   - A run's level belongs to the run: the runner holds none, and a run ends when `use` ends.
//   - A command's end is a Result of an exit or a timeout, with no invented exit code.
//   - One checked request is all the workload steps take.
//   - A proxy has one role, not independent flags.
import type {
    EgressPolicy,
    ExecOutcome,
    GuaranteeLevel,
    ImageDigest,
    Result,
    Runner,
    RunnerError,
    RunnerHandle,
    WorkloadOutcome,
    WorkloadRequest,
} from "@revisum/contracts";
import type { ContainerEngine, EngineProblem } from "@revisum/runner";
import {
    withContainerScope,
    type ContainerScope,
} from "../../packages/runner/src/ContainerScope.ts";
import type { ProxyContainerFields } from "../../packages/runner/src/run-containers.ts";
import type { CheckedWorkloadRequest } from "../../packages/runner/src/workload/CheckWorkloadRequest.ts";
import type { pinWorkloadImages } from "../../packages/runner/src/workload/PinWorkloadImages.ts";
import type { readWorkloadEgress } from "../../packages/runner/src/workload/ReadWorkloadEgress.ts";
import type { runCommandUnderTimeout } from "../../packages/runner/src/workload/RunCommandUnderTimeout.ts";
import type { showEgressControlled } from "../../packages/runner/src/workload/ShowEgressControlled.ts";
import type { startTeamContainer } from "../../packages/runner/src/workload/StartTeamContainer.ts";

type IsExactly<Left, Right> =
    (<Probe>() => Probe extends Left ? 1 : 2) extends <Probe>() => Probe extends Right ? 1 : 2
        ? true
        : false;

// True when any of a step's parameters would take a request nobody checked.
type TakesAnUncheckedRequest<Step extends (...parameters: never[]) => unknown> = {
    [Position in keyof Parameters<Step>]: WorkloadRequest extends Parameters<Step>[Position]
        ? true
        : false;
}[number];

// True when one of a step's parameters is the checked request.
type TakesTheCheckedRequest<Step extends (...parameters: never[]) => unknown> = {
    [Position in keyof Parameters<Step>]: IsExactly<
        Parameters<Step>[Position],
        CheckedWorkloadRequest
    >;
}[number];

type TakesOnlyCheckedRequests<Step extends (...parameters: never[]) => unknown> = [
    TakesAnUncheckedRequest<Step>,
    TakesTheCheckedRequest<Step>,
];

declare const engine: ContainerEngine;
declare const scope: ContainerScope;
declare const runner: Runner;
declare const run: RunnerHandle;
declare const image: ImageDigest;
declare const policy: EgressPolicy;
declare const outcome: WorkloadOutcome;
declare const unmarkedChecked: Omit<CheckedWorkloadRequest, "__brand">;
declare const uncheckedRequest: WorkloadRequest;
declare const withoutDaemonProblem: Omit<ContainerEngine, "daemonProblem">;
declare const withoutGatewayAddress: Omit<ContainerEngine, "networkGatewayAddress">;
declare const withoutImageUser: Omit<ContainerEngine, "imageUser">;
declare const withoutContainerAddress: Omit<ContainerEngine, "containerAddress">;

const NO_OUTPUT = { bytes: new Uint8Array(), truncated: false };
const noLog = (): void => undefined;
const useNothing = (): Promise<void> => Promise.resolve();

export const runnerLifecycleTypeGuarantees = {
    // ---- A complete engine ------------------------------------------------------------------------
    // @ts-expect-error an engine must say why its daemon does not answer
    missingDaemonProblem: withoutDaemonProblem satisfies ContainerEngine,
    // @ts-expect-error an engine must say where a gateway would be
    missingGatewayAddress: withoutGatewayAddress satisfies ContainerEngine,
    // @ts-expect-error an engine must say an image's user
    missingImageUser: withoutImageUser satisfies ContainerEngine,
    // @ts-expect-error an engine must say a container's address
    missingContainerAddress: withoutContainerAddress satisfies ContainerEngine,
    removalsAnswerAResult: [true, true] satisfies [
        IsExactly<
            Awaited<ReturnType<ContainerEngine["removeContainer"]>>,
            Result<void, EngineProblem>
        >,
        IsExactly<
            Awaited<ReturnType<ContainerEngine["removeNetwork"]>>,
            Result<void, EngineProblem>
        >,
    ],

    // ---- A scope's network comes first ------------------------------------------------------------
    // @ts-expect-error a scope's network exists already, so a scope cannot make one
    scopeMakingNetwork: scope.createNetwork({ internal: true }),
    scopeExposesOnlyWhatRunnersUse: true satisfies IsExactly<
        Exclude<
            keyof ContainerScope,
            | "runId"
            | "network"
            | "networkKind"
            | "refusedNetworks"
            | "startContainer"
            | "removeContainer"
        >,
        never
    >,
    scopeWithAKind: withContainerScope(
        engine,
        { namePrefix: "run", networkKinds: ["internal"], log: noLog },
        useNothing,
    ),
    // @ts-expect-error a scope takes its network kinds up front
    scopeWithoutKinds: withContainerScope(engine, { namePrefix: "run", log: noLog }, useNothing),
    scopeWithNoKinds: withContainerScope(
        engine,
        // @ts-expect-error a scope must have at least one network kind to try
        { namePrefix: "run", networkKinds: [], log: noLog },
        useNothing,
    ),

    // ---- A run's level, and its end ---------------------------------------------------------------
    runnerHasOnlyWithRun: true satisfies IsExactly<keyof Runner, "withRun">,
    // @ts-expect-error a runner holds no level of its own
    runnersLevel: runner.guaranteeLevel(),
    // @ts-expect-error a run is started by withRun, and ends with `use`
    runnerStart: runner.start(image, policy),
    // @ts-expect-error a run ends when `use` ends, so a handle cannot stop it
    handleStop: run.stop(),
    runGivesWhatUseReturned: runner.withRun(image, policy, (started) =>
        Promise.resolve(started.guaranteeLevel()),
    ) satisfies Promise<Result<GuaranteeLevel, RunnerError>>,

    // ---- How a command ends -------------------------------------------------------------------------
    execAnswersAResult: run.exec(["true"]) satisfies Promise<Result<ExecOutcome, unknown>>,
    // @ts-expect-error a variable name is a checked value, never bare text
    execWithBareName: run.exec(["true"], ["PLAIN_NAME"]),
    // @ts-expect-error only an outcome that has exited has an exit code
    exitCodeUnread: outcome.exitCode,
    exitedHasACode: outcome.kind === "exited" ? outcome.exitCode : null,
    stdoutHeldEitherWay: outcome.stdout,
    inventedExitCode: {
        kind: "timed-out",
        stop: "removed",
        // @ts-expect-error a timed-out outcome has no exit code to invent
        exitCode: -1,
        egressEvents: [],
        stdout: NO_OUTPUT,
        stderr: NO_OUTPUT,
    } satisfies WorkloadOutcome,

    // ---- One checked request ----------------------------------------------------------------------
    // @ts-expect-error a request with every checked field but no brand is not a checked one
    handBuiltCheckedRequest: unmarkedChecked satisfies CheckedWorkloadRequest,
    // @ts-expect-error the raw request is not a checked one
    rawRequestAsChecked: uncheckedRequest satisfies CheckedWorkloadRequest,
    pinningTakesOnlyChecked: [false, true] satisfies TakesOnlyCheckedRequests<
        typeof pinWorkloadImages
    >,
    egressControlTakesOnlyChecked: [false, true] satisfies TakesOnlyCheckedRequests<
        typeof showEgressControlled
    >,
    teamContainerTakesOnlyChecked: [false, true] satisfies TakesOnlyCheckedRequests<
        typeof startTeamContainer
    >,
    commandRunTakesOnlyChecked: [false, true] satisfies TakesOnlyCheckedRequests<
        typeof runCommandUnderTimeout
    >,
    egressReadTakesOnlyChecked: [false, true] satisfies TakesOnlyCheckedRequests<
        typeof readWorkloadEgress
    >,

    // ---- A proxy's role ---------------------------------------------------------------------------
    roleIsAField: "role" satisfies keyof ProxyContainerFields,
    // @ts-expect-error a proxy's role is one value, not a flag for lookups
    noLookupFlag: "recordLookups" satisfies keyof ProxyContainerFields,
    // @ts-expect-error a proxy's role is one value, not a flag for run addresses
    noAddressFlag: "hasRunAddresses" satisfies keyof ProxyContainerFields,
};
