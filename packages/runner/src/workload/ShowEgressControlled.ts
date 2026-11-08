// Egress control, shown before any code of the team's image runs: a network with no route out, the
// proxy on it, and a probe on that network that fails to get out without the proxy.
import { success, type Failure, type Result, type WorkloadRequest } from "@revisum/contracts";
import type { ContainerEngine } from "../container-engine.ts";
import type { ContainerScope } from "../ContainerScope.ts";
import {
    DEFAULT_BRIDGE_NETWORK,
    ownCodeMounts,
    probeRunNetwork,
    runImageContainer,
} from "../run-containers.ts";
import {
    proxyUnreachableDetail,
    startProxyContainer,
    type StartedProxy,
} from "../StartProxyContainer.ts";
import { workloadRefused, type WorkloadRefusal } from "./WorkloadRefusal.ts";

type EgressControlFields = {
    readonly engine: ContainerEngine;
    readonly root: string;
    readonly dependenciesVolume: string | null;
    readonly runImage: string;
};

const unenforceable = (detail: string): Failure<WorkloadRefusal> =>
    workloadRefused("egress-unenforceable", detail);

export async function showEgressControlled(
    scope: ContainerScope,
    fields: EgressControlFields,
    request: WorkloadRequest,
): Promise<Result<StartedProxy, WorkloadRefusal>> {
    const { engine, root, runImage } = fields;
    const created = await scope.createNetwork({ internal: true });
    if (!created.ok) {
        return unenforceable(
            `Docker could not create a network with no route out: ${created.error.detail}`,
        );
    }
    const proxy = await startProxyContainer(scope, root, {
        image: runImage,
        networks: [scope.network, DEFAULT_BRIDGE_NETWORK],
        policy: request.policy,
        services: request.services,
        mounts: ownCodeMounts(root, fields.dependenciesVolume),
        recordLookups: true,
    });
    if (!proxy.ok) {
        return unenforceable(proxy.error);
    }

    // A container of Revisum's own image on the run's network proves the network has no route
    // out, so the team's image is started only once that is shown.
    const probe = await scope.startContainer(
        runImageContainer(root, {
            name: `${scope.runId}-probe`,
            image: runImage,
            networks: [scope.network],
            environment: { HOME: "/tmp" },
            mounts: [],
            command: ["sleep", "infinity"],
        }),
    );
    if (!probe.ok) {
        return unenforceable(`the probe container did not start: ${probe.error.detail}`);
    }
    const unreachable = await proxyUnreachableDetail(engine, probe.value, proxy.value.name);
    if (unreachable !== null) {
        return unenforceable(`the run's network cannot reach its proxy: ${unreachable}`);
    }
    if ((await probeRunNetwork(engine, probe.value, scope.network)) === "reached") {
        return unenforceable(
            "a connection from inside the run's network reached an address outside, or the Docker host, without the proxy",
        );
    }
    await scope.removeContainer(probe.value);
    return success(proxy.value);
}
