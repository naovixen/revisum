// The containers and the network a run uses, as a scope. The network is made before anything runs in
// it; what is started through the scope is removed in reverse order, the network last, however the run
// ends, each removal tried once and its problem reported to the scope's log. No runner keeps that list
// or remembers the order: a new runner gets both by asking for a scope. A scope asked for no network
// kinds makes none, for a container that needs no network at all.
import { randomBytes } from "node:crypto";
import { failure, success, type Result } from "@revisum/contracts";
import { answeringEngine } from "./AnsweringEngine.ts";
import {
    NetworkFailureKind,
    type ContainerEngine,
    type ContainerOptions,
    type EngineProblem,
    type NetworkFailure,
} from "./ContainerEngine.ts";
import { safeLog } from "./SafeLog.ts";

export const NetworkKind = {
    // No route out of the host and no gateway to the Docker host.
    Internal: "internal",
    Ordinary: "ordinary",
} as const;
export type NetworkKind = (typeof NetworkKind)[keyof typeof NetworkKind];

export type RefusedNetwork = { readonly kind: NetworkKind; readonly detail: string };

// The containers of a scope, with or without a network.
export type ContainerLifetime = {
    readonly runId: string;
    startContainer(options: ContainerOptions): Promise<Result<string, EngineProblem>>;
    // Removes one container now, for a run that is done with it. It is sent once and the scope forgets
    // the container, so its end sends no second one; a problem is both answered and logged.
    removeContainer(containerId: string): Promise<Result<void, EngineProblem>>;
};

type ScopeNetwork = {
    readonly network: string;
    readonly networkKind: NetworkKind;
    // The kinds tried before the one this scope got, and why each was refused.
    readonly refusedNetworks: readonly RefusedNetwork[];
};

export type ContainerScope = ContainerLifetime & ScopeNetwork;

export type ContainerScopeOptions<Kinds extends readonly NetworkKind[] = readonly NetworkKind[]> = {
    readonly namePrefix: string;
    // Tried in order, moving on only when Docker refuses a network with no route out.
    readonly networkKinds: Kinds;
    readonly log: (entry: EngineProblem) => void;
};

type ScopeReport = (detail: string) => void;

// The network fields behind a scope asked for none. Its callers' overload shows them only the
// lifetime, so nothing reads these; "none" is Docker's own name for no network.
const NO_NETWORK: ScopeNetwork = {
    network: "none",
    networkKind: NetworkKind.Ordinary,
    refusedNetworks: [],
};

const refusalsText = (refused: readonly RefusedNetwork[]): string =>
    refused.map((attempt) => `${attempt.kind}: ${attempt.detail}`).join("; ");

async function createFirstNetwork(
    engine: ContainerEngine,
    network: string,
    kinds: readonly NetworkKind[],
): Promise<Result<ScopeNetwork, NetworkFailure>> {
    const refused: RefusedNetwork[] = [];
    const noNetwork = (kind: NetworkFailureKind): Result<ScopeNetwork, NetworkFailure> =>
        failure({ kind, detail: `no network could be made (${refusalsText(refused)})` });
    for (const kind of kinds) {
        const created = await engine.createNetwork(network, {
            internal: kind === NetworkKind.Internal,
        });
        if (created.ok) {
            return success({ network, networkKind: kind, refusedNetworks: refused });
        }
        refused.push({ kind, detail: created.error.detail });
        if (created.error.kind === NetworkFailureKind.Failed) {
            return noNetwork(NetworkFailureKind.Failed);
        }
    }
    return noNetwork(NetworkFailureKind.InternalRefused);
}

function containerLifetime(
    engine: ContainerEngine,
    runId: string,
    held: Set<string>,
    removals: Promise<unknown>[],
    report: ScopeReport,
): ContainerLifetime {
    const removeAndReport = async (containerId: string): Promise<Result<void, EngineProblem>> => {
        const removed = await engine.removeContainer(containerId);
        if (!removed.ok) {
            report(`the container ${containerId} could not be removed: ${removed.error.detail}`);
        }
        return removed;
    };
    return {
        runId,
        async startContainer(container) {
            const started = await engine.startContainer(container);
            if (started.ok) {
                held.add(started.value);
            }
            return started;
        },
        removeContainer(containerId) {
            if (!held.delete(containerId)) {
                return Promise.resolve(
                    failure({
                        detail: `the scope holds no container ${containerId}: it was never started here or has been removed`,
                    }),
                );
            }
            const removal = removeAndReport(containerId);
            removals.push(removal);
            return removal;
        },
    };
}

// Everything a scope started goes, whatever happened: this never rejects. A removal the run sent that
// has not answered is waited for, since Docker cannot remove a network with a container still on it.
// The answering engine bounds each one, so a removal that never answers cannot hold the scope open.
async function removeEverything(
    engine: ContainerEngine,
    held: ReadonlySet<string>,
    removals: readonly Promise<unknown>[],
    network: string | null,
    report: ScopeReport,
): Promise<void> {
    for (const containerId of [...held].reverse()) {
        const removed = await engine.removeContainer(containerId);
        if (!removed.ok) {
            report(`the container ${containerId} could not be removed: ${removed.error.detail}`);
        }
    }
    await Promise.all(removals);
    if (network === null) {
        return;
    }
    const removedNetwork = await engine.removeNetwork(network);
    if (!removedNetwork.ok) {
        report(`the network ${network} could not be removed: ${removedNetwork.error.detail}`);
    }
}

// A scope for a run that ends with `use`: everything it started is gone when this returns, and its
// network is there before `use` starts. A failure means no network could be made, and `use` was not
// called; a scope asked for no network kinds cannot fail. What `use` returned is given back whatever
// the removals did, and what it threw is rethrown.
export function withContainerScope<Value>(
    engine: ContainerEngine,
    options: ContainerScopeOptions<readonly []>,
    use: (scope: ContainerLifetime) => Promise<Value>,
): Promise<Result<Value, never>>;
export function withContainerScope<Value>(
    engine: ContainerEngine,
    options: ContainerScopeOptions<readonly [NetworkKind, ...NetworkKind[]]>,
    use: (scope: ContainerScope) => Promise<Value>,
): Promise<Result<Value, NetworkFailure>>;
export async function withContainerScope<Value>(
    wrappedEngine: ContainerEngine,
    options: ContainerScopeOptions,
    use: (scope: ContainerScope) => Promise<Value>,
): Promise<Result<Value, NetworkFailure>> {
    // A scope can be asked for by itself, so it guards the engine it is given. Over an engine a
    // runner has already wrapped, that changes nothing.
    const engine = answeringEngine(wrappedEngine);
    const log = safeLog(options.log);
    const report: ScopeReport = (detail) => {
        log({ detail });
    };
    const runId = `${options.namePrefix}-${randomBytes(6).toString("hex")}`;
    const isNetworked = options.networkKinds.length > 0;
    const made = isNetworked
        ? await createFirstNetwork(engine, `${runId}-network`, options.networkKinds)
        : success(NO_NETWORK);
    if (!made.ok) {
        return made;
    }
    const held = new Set<string>();
    const removals: Promise<unknown>[] = [];
    const lifetime = containerLifetime(engine, runId, held, removals, report);
    try {
        return success(await use({ ...lifetime, ...made.value }));
    } finally {
        const network = isNetworked ? made.value.network : null;
        await removeEverything(engine, held, removals, network, report);
    }
}
