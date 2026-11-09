// How a run's egress proxy comes up, the same for every runner: its container, with the policy's
// rules, and the wait until a container on the run's network can reach it.
import { failure, success, type Result } from "@revisum/contracts";
import type { ContainerEngine } from "../containers/ContainerEngine.ts";
import type { ContainerScope } from "../containers/ContainerScope.ts";
import {
    proxyContainer,
    proxyReadyScript,
    type ProxyContainerFields,
} from "../containers/RunImageContainer.ts";
import { readInContainer } from "../containers/WithinReadBound.ts";

export type StartedProxy = { readonly id: string; readonly name: string };

// Starts the proxy under the scope's name for it. A refusal says why, for the runner's log.
export async function startProxyContainer(
    scope: ContainerScope,
    root: string,
    fields: Omit<ProxyContainerFields, "name">,
): Promise<Result<StartedProxy, string>> {
    const name = `${scope.runId}-proxy`;
    const options = proxyContainer(root, { ...fields, name });
    if (!options.ok) {
        return failure(`the egress proxy's rules were refused: ${options.error.message}`);
    }
    const proxy = await scope.startContainer(options.value);
    if (!proxy.ok) {
        return failure(`the proxy container did not start: ${proxy.error.detail}`);
    }
    return success({ id: proxy.value, name });
}

// Waits, from a container on the run's network, until the proxy answers. Null when it did, otherwise
// what went wrong.
export async function proxyUnreachableDetail(
    engine: ContainerEngine,
    containerId: string,
    proxyName: string,
): Promise<string | null> {
    const ready = await readInContainer(engine, containerId, [
        "node",
        "-e",
        proxyReadyScript(proxyName),
    ]);
    if (ready.ok && ready.value.exitCode === 0) {
        return null;
    }
    return ready.ok ? ready.value.stderr.trim() : ready.error.detail;
}
