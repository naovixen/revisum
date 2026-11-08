// The containers and the network a run uses, as a scope. What is started through it is removed in
// reverse order, the network last, however the run ends, so no runner keeps that list or remembers
// the order: a new runner gets both by asking for a scope.
import { randomBytes } from "node:crypto";
import { success, type Result } from "@revisum/contracts";
import type { ContainerEngine, ContainerOptions, EngineProblem } from "./container-engine.ts";

export type ContainerScope = {
    readonly runId: string;
    readonly network: string;
    createNetwork(options: { readonly internal: boolean }): Promise<Result<void, EngineProblem>>;
    startContainer(options: ContainerOptions): Promise<Result<string, EngineProblem>>;
    // Removes one container now, for a run that is done with it, so it is not removed again.
    removeContainer(containerId: string): Promise<void>;
};

// Removes what is still in a scope. Safe to call more than once.
export type RemoveAll = () => Promise<void>;

type OpenContainerScope = AsyncDisposable & {
    readonly scope: ContainerScope;
    readonly removeAll: RemoveAll;
    keep(): void;
};

function openContainerScope(engine: ContainerEngine, namePrefix: string): OpenContainerScope {
    const runId = `${namePrefix}-${randomBytes(6).toString("hex")}`;
    const network = `${runId}-network`;
    const containers = new Set<string>();
    const state = { hasNetwork: false, isKept: false };
    const removeAll: RemoveAll = async () => {
        const removing = [...containers].reverse();
        containers.clear();
        for (const containerId of removing) {
            await engine.removeContainer(containerId);
        }
        if (state.hasNetwork) {
            await engine.removeNetwork(network);
        }
        state.hasNetwork = false;
    };
    return {
        scope: {
            runId,
            network,
            async createNetwork(options) {
                const created = await engine.createNetwork(network, options);
                if (!created.ok) {
                    return created;
                }
                state.hasNetwork = true;
                return success(undefined);
            },
            async startContainer(options) {
                const started = await engine.startContainer(options);
                if (started.ok) {
                    containers.add(started.value);
                }
                return started;
            },
            async removeContainer(containerId) {
                await engine.removeContainer(containerId);
                containers.delete(containerId);
            },
        },
        removeAll,
        keep() {
            state.isKept = true;
        },
        async [Symbol.asyncDispose]() {
            if (!state.isKept) {
                await removeAll();
            }
        },
    };
}

// A scope for a run that ends with `use`: everything it started is gone when this returns.
export async function withContainerScope<Value>(
    engine: ContainerEngine,
    namePrefix: string,
    use: (scope: ContainerScope) => Promise<Value>,
): Promise<Value> {
    await using open = openContainerScope(engine, namePrefix);
    return await use(open.scope);
}

// A scope for a run that outlives its setup, such as one handed to a caller to use. It is removed
// when `setUp` fails or throws; when `setUp` succeeds it stays, and `removeAll` is how its value ends it.
export async function keepingContainerScope<Value, Problem>(
    engine: ContainerEngine,
    namePrefix: string,
    setUp: (scope: ContainerScope, removeAll: RemoveAll) => Promise<Result<Value, Problem>>,
): Promise<Result<Value, Problem>> {
    await using open = openContainerScope(engine, namePrefix);
    const outcome = await setUp(open.scope, open.removeAll);
    if (outcome.ok) {
        open.keep();
    }
    return outcome;
}
