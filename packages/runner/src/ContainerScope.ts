// The containers and the network a run uses, as a scope. The network is made before anything runs in
// it; what is started through the scope is removed in reverse order, the network last, however the run
// ends, each removal tried once and its problem reported to the scope's log. No runner keeps that list
// or remembers the order: a new runner gets both by asking for a scope.
import { randomBytes } from "node:crypto";
import { failure, success, type Result } from "@revisum/contracts";
import { adapterAnswer, type ProblemDetail } from "./AdapterAnswer.ts";
import type { ContainerEngine, ContainerOptions, EngineProblem } from "./container-engine.ts";

export const NetworkKind = {
    // No route out of the host and no gateway to the Docker host.
    Internal: "internal",
    Ordinary: "ordinary",
} as const;
export type NetworkKind = (typeof NetworkKind)[keyof typeof NetworkKind];

export type RefusedNetwork = { readonly kind: NetworkKind; readonly detail: string };

export type ContainerScope = {
    readonly runId: string;
    readonly network: string;
    readonly networkKind: NetworkKind;
    // The kinds tried before the one this scope got, and why each was refused.
    readonly refusedNetworks: readonly RefusedNetwork[];
    startContainer(options: ContainerOptions): Promise<Result<string, EngineProblem>>;
    // Removes one container now, for a run that is done with it. It is sent once and the scope forgets
    // the container, so its end sends no second one; a problem is both answered and logged.
    removeContainer(containerId: string): Promise<Result<void, EngineProblem>>;
};

export type ContainerScopeOptions = {
    readonly namePrefix: string;
    // Tried in order, until one is made.
    readonly networkKinds: readonly [NetworkKind, ...NetworkKind[]];
    readonly log: (entry: ProblemDetail) => void;
};

type ScopeReport = (detail: string) => void;

// A log that throws has nothing left to report with, and must not stop the removals.
const reporterOf =
    (log: ContainerScopeOptions["log"]): ScopeReport =>
    (detail) => {
        try {
            log({ detail });
        } catch {
            // The log is what failed.
        }
    };

type NetworkAttempt = {
    readonly kind: NetworkKind | null;
    readonly refused: readonly RefusedNetwork[];
};

async function createFirstNetwork(
    engine: ContainerEngine,
    network: string,
    kinds: readonly NetworkKind[],
): Promise<NetworkAttempt> {
    const refused: RefusedNetwork[] = [];
    for (const kind of kinds) {
        const created = await adapterAnswer(() =>
            engine.createNetwork(network, { internal: kind === NetworkKind.Internal }),
        );
        if (created.ok) {
            return { kind, refused };
        }
        refused.push({ kind, detail: created.error.detail });
    }
    return { kind: null, refused };
}

const refusalsText = (refused: readonly RefusedNetwork[]): string =>
    refused.map((attempt) => `${attempt.kind}: ${attempt.detail}`).join("; ");

// Everything a scope started goes, whatever happened: this never rejects.
async function removeEverything(
    engine: ContainerEngine,
    held: ReadonlySet<string>,
    network: string,
    report: ScopeReport,
): Promise<void> {
    for (const containerId of [...held].reverse()) {
        const removed = await adapterAnswer(() => engine.removeContainer(containerId));
        if (!removed.ok) {
            report(`the container ${containerId} could not be removed: ${removed.error.detail}`);
        }
    }
    const removed = await adapterAnswer(() => engine.removeNetwork(network));
    if (!removed.ok) {
        report(`the network ${network} could not be removed: ${removed.error.detail}`);
    }
}

// A scope for a run that ends with `use`: everything it started is gone when this returns, and its
// network is there before `use` starts. A failure means no network could be made, and `use` was not
// called. What `use` returned is given back whatever the removals did, and what it threw is rethrown.
export async function withContainerScope<Value>(
    engine: ContainerEngine,
    options: ContainerScopeOptions,
    use: (scope: ContainerScope) => Promise<Value>,
): Promise<Result<Value, ProblemDetail>> {
    const runId = `${options.namePrefix}-${randomBytes(6).toString("hex")}`;
    const network = `${runId}-network`;
    const attempt = await createFirstNetwork(engine, network, options.networkKinds);
    if (attempt.kind === null) {
        return failure({ detail: `no network could be made (${refusalsText(attempt.refused)})` });
    }
    const report = reporterOf(options.log);
    const held = new Set<string>();
    const scope: ContainerScope = {
        runId,
        network,
        networkKind: attempt.kind,
        refusedNetworks: attempt.refused,
        async startContainer(container) {
            const started = await adapterAnswer(() => engine.startContainer(container));
            if (started.ok) {
                held.add(started.value);
            }
            return started;
        },
        async removeContainer(containerId) {
            if (!held.delete(containerId)) {
                return failure({
                    detail: `the scope holds no container ${containerId}: it was never started here or has been removed`,
                });
            }
            const removed = await adapterAnswer(() => engine.removeContainer(containerId));
            if (!removed.ok) {
                report(
                    `the container ${containerId} could not be removed: ${removed.error.detail}`,
                );
            }
            return removed;
        },
    };
    try {
        return success(await use(scope));
    } finally {
        await removeEverything(engine, held, network, report);
    }
}
