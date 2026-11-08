// Compile-time guarantees of the runners' lifecycle. Type-checked by type-check.test.ts, never run:
// each @ts-expect-error line must stay an error, and tsc reports one that compiles.
//   - An engine is complete: omitting any member fails to compile, and removals answer a Result.
//   - A scope's network exists before anything can start in it: a scope has no way to make one,
//     and only asks for what a runner uses.
//   - A run's level belongs to the run: the runner holds none, a run ends when `use` ends, and what
//     it finally read comes back with `use`'s value.
//   - A workload runner always has removeFromOutput: one with no use for it does nothing.
//   - A command's end is a Result of an exit or a timeout, with no invented exit code.
//   - One checked request is all the workload steps take.
//   - A proxy has one role, not independent flags.
import type {
    AppliedRewrite,
    EgressPolicy,
    ExecOutcome,
    GuaranteeLevel,
    ImageDigest,
    ProxyDecision,
    Result,
    Runner,
    RunnerError,
    RunnerHandle,
    WorkloadOutcome,
    WorkloadRequest,
    WorkloadRunner,
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

// Each is mapped over a type parameter so that a tuple stays a tuple, position by position.
type AcceptsAnUncheckedRequest<List extends readonly unknown[]> = true extends {
    [Position in keyof List]: WorkloadRequest extends List[Position] ? true : false;
}[number]
    ? true
    : false;

type IncludesTheCheckedRequest<List extends readonly unknown[]> = true extends {
    [Position in keyof List]: IsExactly<List[Position], CheckedWorkloadRequest>;
}[number]
    ? true
    : false;

type TakesOnlyCheckedRequests<Step extends (...parameters: never[]) => unknown> = [
    AcceptsAnUncheckedRequest<Parameters<Step>>,
    IncludesTheCheckedRequest<Parameters<Step>>,
] extends [false, true]
    ? true
    : false;

type StepTakingTheRawRequest = (request: WorkloadRequest) => Promise<void>;
type StepTakingBothRequests = (
    checked: CheckedWorkloadRequest,
    request: WorkloadRequest,
) => Promise<void>;
type StepTakingNoRequest = (engine: ContainerEngine) => Promise<void>;

declare const engine: ContainerEngine;
declare const runner: Runner;
declare const run: RunnerHandle;
declare const image: ImageDigest;
declare const policy: EgressPolicy;
declare const outcome: WorkloadOutcome;
declare const unmarkedChecked: Omit<CheckedWorkloadRequest, "__brand">;
declare const uncheckedRequest: WorkloadRequest;
declare const withoutGatewayAddress: Omit<ContainerEngine, "networkGatewayAddress">;
declare const withoutImageUser: Omit<ContainerEngine, "imageUser">;
declare const withoutContainerAddress: Omit<ContainerEngine, "containerAddress">;
declare const withoutRemoveFromOutput: Omit<WorkloadRunner, "removeFromOutput">;

const NO_OUTPUT = { bytes: new Uint8Array(), truncated: false };
const noLog = (): void => undefined;
const useNothing = (): Promise<void> => Promise.resolve();

export const runnerLifecycleTypeGuarantees = {
    // ---- A complete engine ------------------------------------------------------------------------
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

    imageUserAndAddressAnswerAResult: [true, true] satisfies [
        IsExactly<
            Awaited<ReturnType<ContainerEngine["imageUser"]>>,
            Result<string | null, EngineProblem>
        >,
        IsExactly<
            Awaited<ReturnType<ContainerEngine["containerAddress"]>>,
            Result<string, EngineProblem>
        >,
    ],
    networkFailureNamesARefusal: true satisfies IsExactly<
        Extract<
            Awaited<ReturnType<ContainerEngine["createNetwork"]>>,
            { ok: false }
        >["error"]["kind"],
        "internal-refused" | "failed"
    >,

    // ---- A scope's network comes first ------------------------------------------------------------
    // @ts-expect-error a scope's network exists already, so a scope cannot make one
    scopeMakingNetwork: "createNetwork" satisfies keyof ContainerScope,
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
    // A scope asked for no network kinds gets no network: the output-removal container has none.
    scopeWithNoNetwork: withContainerScope(
        engine,
        { namePrefix: "run", networkKinds: [], log: noLog },
        useNothing,
    ),

    // ---- A run's level, and its end ---------------------------------------------------------------
    runnerHasOnlyWithRun: true satisfies IsExactly<keyof Runner, "withRun">,
    // @ts-expect-error a runner holds no level of its own
    runnersLevel: "guaranteeLevel" satisfies keyof Runner,
    // @ts-expect-error a run is started by withRun, and ends with `use`
    runnerStart: "start" satisfies keyof Runner,
    // @ts-expect-error a run ends when `use` ends, so a handle cannot stop it
    handleStop: "stop" satisfies keyof RunnerHandle,
    runGivesWhatUseReturned: runner.withRun(image, policy, (started) =>
        Promise.resolve(started.guaranteeLevel()),
    ) satisfies Promise<
        Result<
            {
                readonly value: GuaranteeLevel;
                readonly final: {
                    readonly guaranteeLevel: GuaranteeLevel;
                    readonly proxyDecisions: readonly ProxyDecision[];
                    readonly rewritesApplied: readonly AppliedRewrite[];
                };
            },
            RunnerError
        >
    >,

    // ---- A workload runner always removes what it left ---------------------------------------------
    // @ts-expect-error a workload runner must offer removeFromOutput, a do-nothing one where it has no use
    missingRemoveFromOutput: withoutRemoveFromOutput satisfies WorkloadRunner,

    // ---- How a command ends -------------------------------------------------------------------------
    execAnswersAResult: run.exec(["true"]) satisfies Promise<Result<ExecOutcome, unknown>>,
    // @ts-expect-error a variable name is a checked value, never bare text
    execWithBareName: run.exec(["true"], ["PLAIN_NAME"]),
    // @ts-expect-error only an outcome that has exited has an exit code
    exitCodeUnread: "exitCode" satisfies keyof WorkloadOutcome,
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
    pinningTakesOnlyChecked: true satisfies TakesOnlyCheckedRequests<typeof pinWorkloadImages>,
    egressControlTakesOnlyChecked: true satisfies TakesOnlyCheckedRequests<
        typeof showEgressControlled
    >,
    teamContainerTakesOnlyChecked: true satisfies TakesOnlyCheckedRequests<
        typeof startTeamContainer
    >,
    commandRunTakesOnlyChecked: true satisfies TakesOnlyCheckedRequests<
        typeof runCommandUnderTimeout
    >,
    egressReadTakesOnlyChecked: true satisfies TakesOnlyCheckedRequests<typeof readWorkloadEgress>,
    // @ts-expect-error a step that takes the raw request is not one over checked requests
    rawRequestStep: true satisfies TakesOnlyCheckedRequests<StepTakingTheRawRequest>,
    // @ts-expect-error a step that also takes the raw request is not one over checked requests
    bothRequestsStep: true satisfies TakesOnlyCheckedRequests<StepTakingBothRequests>,
    // @ts-expect-error a step with no checked request is not one over checked requests
    noRequestStep: true satisfies TakesOnlyCheckedRequests<StepTakingNoRequest>,

    // ---- A proxy's role ---------------------------------------------------------------------------
    roleIsAField: "role" satisfies keyof ProxyContainerFields,
    // @ts-expect-error a proxy's role is one value, not a flag for lookups
    noLookupFlag: "recordLookups" satisfies keyof ProxyContainerFields,
    // @ts-expect-error a proxy's role is one value, not a flag for run addresses
    noAddressFlag: "hasRunAddresses" satisfies keyof ProxyContainerFields,
};
