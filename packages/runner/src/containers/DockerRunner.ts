// The isolated runner on a container engine. A run gets its own Docker network with no route out
// (--internal), a run container that joins only that network, and a proxy container, from the same
// image, that joins it and the default bridge and runs the egress proxy. The browser is pointed at
// the proxy, so a request that bypasses it has nowhere to go.
//
// The runner claims the isolated guarantee level only once all three have started and direct
// connections from inside the run container, to addresses outside and to the Docker host through
// any gateway the network kept, have failed. Otherwise the run still starts, at the host level, and
// logs egress-unenforceable, so no report claims isolation.
// Nothing reaches the containers from the host's environment: each environment is built from an
// empty list, and only the code, dependencies and browsers the run needs are mounted, read-only.
import {
    RunnerErrorCode,
    PRODUCT,
    failure,
    success,
    type AppliedRewrite,
    type DeclaredService,
    type EgressPolicy,
    type FinalRunFacts,
    type FinishedRun,
    type ImageDigest,
    type ProxyDecision,
    type Result,
    type Runner,
    type RunnerError,
    type RunnerHandle,
    GuaranteeLevel,
} from "@revisum/contracts";
import { join } from "node:path";
import { answeringEngine } from "./AnsweringEngine.ts";
import type { ContainerEngine, ContainerMount } from "./ContainerEngine.ts";
import { NetworkKind, withContainerScope, type ContainerScope } from "./ContainerScope.ts";
import { joinEgressEvents } from "../egress/JoinEgressEvents.ts";
import {
    DEFAULT_BRIDGE_NETWORK,
    ProxyRole,
    WORKSPACE,
    dependenciesVolumeFor,
    hasProxyLostRecords,
    ownCodeMounts,
    probeRunNetwork,
    proxyUrl,
    readAppliedRewrites,
    readDecisions,
    repositoryFolder,
    runImageContainer,
    serviceProxyUrl,
} from "./RunImageContainer.ts";
import { SERVICE_PROXY_VARIABLE } from "../egress/StartRecordKeeping.ts";
import { RUN_IMAGE_TAG } from "../image/RunImage.ts";
import { safeLog } from "./SafeLog.ts";
import { proxyUnreachableDetail, startProxyContainer } from "../egress/StartProxyContainer.ts";
import { MountKind, ImageAnswerKind } from "./ContainerEngine.ts";

export type RunnerLogEntry = {
    readonly code: "egress-unenforceable" | "start-failed" | "cleanup-failed";
    readonly detail: string;
};

export type DockerRunnerOptions = {
    readonly engine: ContainerEngine;
    readonly repositoryRoot: string;
    // Repository-relative folders the run gets read-only, beside packages, node_modules and .browsers.
    readonly inputs?: readonly string[];
    // The trusted project's declared services; the policy says which of them the run may call.
    readonly services?: readonly DeclaredService[];
    // The Docker volume holding Linux dependencies, for a host whose own node_modules are not
    // Linux's. Defaults to the dev container's volume everywhere but Linux, where the repository's
    // own node_modules folder is mounted.
    readonly dependenciesVolume?: string | null;
    readonly log?: (entry: RunnerLogEntry) => void;
};

type RunnerLog = (entry: RunnerLogEntry) => void;

// What a run's setup needs, built once per start.
type RunSetup = {
    readonly engine: ContainerEngine;
    readonly root: string;
    readonly log: RunnerLog;
    readonly image: ImageDigest;
    readonly policy: EgressPolicy;
    readonly services: readonly DeclaredService[] | undefined;
    readonly inputs: readonly string[];
    readonly ownMounts: readonly ContainerMount[];
};

type RunContainerIds = {
    readonly runId: string;
    readonly proxyId: string;
    readonly runContainerId: string;
};

// Null when the run image is here and is the one pinned, otherwise why it cannot be used. A daemon
// that does not answer says nothing about whether the image exists.
async function pinRunImage(
    engine: ContainerEngine,
    image: ImageDigest,
    log: RunnerLog,
): Promise<RunnerError | null> {
    const local = await engine.imageId(RUN_IMAGE_TAG);
    switch (local.kind) {
        case ImageAnswerKind.Found:
            return local.id === image ? null : { code: RunnerErrorCode.ImageDigestMismatch };
        case ImageAnswerKind.Absent:
            return { code: RunnerErrorCode.ImageMissing };
        case ImageAnswerKind.Unanswered:
            log({ code: "start-failed", detail: `Docker did not answer: ${local.problem.detail}` });
            return { code: RunnerErrorCode.StartFailed };
    }
}

// The inputs as folders inside the repository, or null when one is not.
function repositoryInputs(inputs: readonly string[], log: RunnerLog): readonly string[] | null {
    const folders: string[] = [];
    for (const input of inputs) {
        const folder = repositoryFolder(input);
        if (folder === null) {
            log({
                code: "start-failed",
                detail: `the input ${input} is not a folder inside the repository`,
            });
            return null;
        }
        folders.push(folder);
    }
    return folders;
}

// A browser takes HTTP_PROXY by default, so that is the address that closes the socket on a
// refusal. Whatever calls services has to ask for the one that answers. Wrongly used, that gives a
// service a failed call, never a page a readable answer.
function runContainerEnvironment(proxyName: string): Readonly<Record<string, string>> {
    const browserAddress = proxyUrl(proxyName);
    return {
        HOME: "/tmp",
        HTTP_PROXY: browserAddress,
        HTTPS_PROXY: browserAddress,
        NO_PROXY: "localhost,127.0.0.1,::1",
        "http_proxy": browserAddress,
        "https_proxy": browserAddress,
        "no_proxy": "localhost,127.0.0.1,::1",
        [SERVICE_PROXY_VARIABLE]: serviceProxyUrl(proxyName),
    };
}

// The handle `use` is given, and how the run ends: what the proxy decided is read once more, and from
// then on nothing can reach the containers through the handle.
type OpenRun = { readonly handle: RunnerHandle; readonly end: () => Promise<FinalRunFacts> };

function openRun(setup: RunSetup, ids: RunContainerIds, startingLevel: GuaranteeLevel): OpenRun {
    const { engine, log } = setup;
    const { runContainerId, proxyId } = ids;
    let decisions: readonly ProxyDecision[] = [];
    let rewrites: readonly AppliedRewrite[] = [];
    let level = startingLevel;
    let hasEnded = false;
    const fallToHost = (detail: string): void => {
        if (level === GuaranteeLevel.Isolated) {
            level = "host";
            log({ code: "egress-unenforceable", detail });
        }
    };
    // A read that fails keeps what the last one found, since each file only grows. But the record may
    // then be incomplete, and egress is enforced only as far as it can be shown, so the run no longer
    // counts as isolated.
    const refreshEvidence = async (): Promise<void> => {
        const [readNow, appliedNow, hasLostRecords] = await Promise.all([
            readDecisions(engine, proxyId),
            readAppliedRewrites(engine, proxyId),
            hasProxyLostRecords(engine, proxyId),
        ]);
        decisions = readNow ?? decisions;
        rewrites = appliedNow ?? rewrites;
        if (readNow === null || hasLostRecords) {
            fallToHost("what the proxy decided could not be read back whole");
        }
    };
    const handle: RunnerHandle = {
        runId: ids.runId,
        egressEvents: (records = [], directOrigins = []) =>
            joinEgressEvents(records, decisions, directOrigins),
        proxyDecisions: () => decisions,
        rewritesApplied: () => rewrites,
        async exec(command, environmentNames = []) {
            if (hasEnded) {
                return failure({ detail: "the run has ended, so its containers are gone" });
            }
            const outcome = await engine.exec(runContainerId, command, environmentNames);
            await refreshEvidence();
            return outcome;
        },
        guaranteeLevel: () => level,
    };
    return {
        handle,
        end: async () => {
            hasEnded = true;
            await refreshEvidence();
            return { guaranteeLevel: level, proxyDecisions: decisions, rewritesApplied: rewrites };
        },
    };
}

// The proxy and the run container, in their order, and what they show about egress. A problem leaves
// nothing behind, since the scope removes whatever was started.
async function startRunInScope(
    setup: RunSetup,
    scope: ContainerScope,
): Promise<Result<OpenRun, RunnerError>> {
    const { engine, root, log, image, inputs, ownMounts } = setup;
    const refuse = (detail: string): Result<OpenRun, RunnerError> => {
        log({ code: "start-failed", detail });
        return failure({ code: RunnerErrorCode.StartFailed });
    };
    // Where Docker cannot make a network with no route out, the run goes ahead on an ordinary one, at the host level.
    const whyNotEnforced =
        scope.networkKind === NetworkKind.Internal
            ? null
            : `Docker could not create a network with no route out: ${scope.refusedNetworks.map((refused) => refused.detail).join("; ")}`;

    const proxy = await startProxyContainer(scope, root, {
        image,
        networks:
            whyNotEnforced === null ? [scope.network, DEFAULT_BRIDGE_NETWORK] : [scope.network],
        policy: setup.policy,
        services: setup.services,
        mounts: ownMounts,
        role: ProxyRole.RunContainer,
    });
    if (!proxy.ok) {
        return refuse(proxy.error);
    }

    const runMounts: ContainerMount[] = [
        ...ownMounts,
        {
            kind: MountKind.Folder,
            source: join(root, ".browsers"),
            target: `${WORKSPACE}/.browsers`,
        },
        ...inputs.map((input): ContainerMount => ({
            kind: MountKind.Folder,
            source: join(root, input),
            target: `${WORKSPACE}/${input}`,
        })),
    ];
    const runContainer = await scope.startContainer(
        runImageContainer(root, {
            name: `${scope.runId}-run`,
            image,
            networks: [scope.network],
            environment: runContainerEnvironment(proxy.value.name),
            mounts: runMounts,
            command: ["sleep", "infinity"],
        }),
    );
    if (!runContainer.ok) {
        return refuse(`the run container did not start: ${runContainer.error.detail}`);
    }

    const unreachable = await proxyUnreachableDetail(engine, runContainer.value, proxy.value.name);
    if (unreachable !== null) {
        return refuse(`the run container cannot reach its proxy: ${unreachable}`);
    }

    const unenforceable =
        whyNotEnforced ??
        ((await probeRunNetwork(engine, runContainer.value, scope.network)) === "reached"
            ? "a connection from inside the run container reached an address outside, or the Docker host, without the proxy"
            : null);
    if (unenforceable !== null) {
        log({ code: "egress-unenforceable", detail: unenforceable });
    }
    const ids = { runId: scope.runId, proxyId: proxy.value.id, runContainerId: runContainer.value };
    return success(openRun(setup, ids, unenforceable === null ? "isolated" : "host"));
}

// `use` over a started run. The last read of the proxy's evidence and the end of the handle happen
// before the scope removes the containers, whatever `use` did.
async function useRun<Value>(
    setup: RunSetup,
    scope: ContainerScope,
    use: (run: RunnerHandle) => Promise<Value>,
): Promise<Result<FinishedRun<Value>, RunnerError>> {
    const opened = await startRunInScope(setup, scope);
    if (!opened.ok) {
        return opened;
    }
    const { handle, end } = opened.value;
    let value: Value;
    try {
        value = await use(handle);
    } catch (thrown) {
        await end();
        throw thrown;
    }
    return success({ value, final: await end() });
}

export function dockerRunner(options: DockerRunnerOptions): Runner {
    const engine = answeringEngine(options.engine);
    const root = options.repositoryRoot;
    const log: RunnerLog = safeLog(options.log ?? ((): void => undefined));
    const ownMounts = ownCodeMounts(root, dependenciesVolumeFor(options.dependenciesVolume));

    return {
        async withRun(image, policy, use) {
            const refusal = await pinRunImage(engine, image, log);
            if (refusal !== null) {
                return failure(refusal);
            }
            const inputs = repositoryInputs(options.inputs ?? [], log);
            if (inputs === null) {
                return failure({ code: RunnerErrorCode.StartFailed });
            }
            const setup: RunSetup = {
                engine,
                root,
                log,
                image,
                policy,
                services: options.services,
                inputs,
                ownMounts,
            };
            const scoped = await withContainerScope(
                engine,
                {
                    namePrefix: `${PRODUCT.name}-run`,
                    networkKinds: [NetworkKind.Internal, NetworkKind.Ordinary],
                    log: (entry) => log({ code: "cleanup-failed", detail: entry.detail }),
                },
                (scope) => useRun(setup, scope, use),
            );
            if (!scoped.ok) {
                log({
                    code: "start-failed",
                    detail: `Docker could not create the run's network: ${scoped.error.detail}`,
                });
                return failure({ code: RunnerErrorCode.StartFailed });
            }
            return scoped.value;
        },
    };
}
