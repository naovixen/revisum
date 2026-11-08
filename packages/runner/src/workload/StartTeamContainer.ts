// The team's container, joined to the run's network and nothing else, with the checkout read-only and
// the output folder as its only writable mount.
import {
    WORKLOAD_CHECKOUT_PATH,
    WORKLOAD_OUTPUT_PATH,
    success,
    type Result,
    type WorkloadRequest,
} from "@revisum/contracts";
import type { ContainerEngine, HostEntry } from "../container-engine.ts";
import type { ContainerScope } from "../ContainerScope.ts";
import { proxyUrl } from "../run-containers.ts";
import type { StartedProxy } from "../StartProxyContainer.ts";
import { workloadEnvironment } from "../workload-environment.ts";
import { checkoutMounts } from "./CheckoutMounts.ts";
import type { CheckedWorkloadRequest } from "./CheckWorkloadRequest.ts";
import { readyOutputFolder } from "./ReadyOutputFolder.ts";
import { relayedHostNames } from "./RelayedHostNames.ts";
import { teamImageContainer } from "./TeamImageContainer.ts";
import { workloadRefused, type WorkloadLog, type WorkloadRefusal } from "./WorkloadRefusal.ts";

type TeamContainerFields = {
    readonly engine: ContainerEngine;
    readonly root: string;
    readonly checkout: string;
    readonly log: WorkloadLog;
};

const START_FAILED = "workload-start-failed";

// The id of the started container.
export async function startTeamContainer(
    scope: ContainerScope,
    fields: TeamContainerFields,
    request: WorkloadRequest,
    checked: CheckedWorkloadRequest,
    proxy: StartedProxy,
): Promise<Result<string, WorkloadRefusal>> {
    const { engine, root, checkout, log } = fields;
    const environment = workloadEnvironment(
        request.environment,
        proxyUrl(proxy.name),
        request.httpProxyVariables !== false,
    );
    if (environment === null) {
        return workloadRefused(
            START_FAILED,
            "a declared variable has a name an environment cannot hold",
        );
    }
    const mounts = checkoutMounts(checkout, log);
    if (mounts === null) {
        return workloadRefused(START_FAILED, "the checkout cannot be read");
    }
    if (!readyOutputFolder(request.outputDirectory)) {
        return workloadRefused(START_FAILED, "the output folder cannot be made writable");
    }
    const imageUser = (await engine.imageUser?.(request.image)) ?? null;
    const proxyAddress = (await engine.containerAddress?.(proxy.id, scope.network)) ?? null;
    if (proxyAddress === null) {
        log({
            code: "notice",
            detail: "the proxy has no address on the run's network, so lookups are not recorded",
        });
    }
    // A relayed service is reached by name at the proxy, so without the proxy's address it cannot be reached.
    const relayedNames = relayedHostNames(request);
    if (relayedNames.length > 0 && proxyAddress === null) {
        return workloadRefused(
            START_FAILED,
            "the proxy has no address on the run's network, so the service allowed over TCP cannot be reached",
        );
    }
    const hosts: HostEntry[] =
        proxyAddress === null ? [] : relayedNames.map((name) => ({ name, address: proxyAddress }));

    const team = await scope.startContainer(
        teamImageContainer(root, imageUser, {
            name: `${scope.runId}-workload`,
            image: request.image,
            networks: [scope.network],
            workingFolder:
                checked.workingFolder === ""
                    ? WORKLOAD_CHECKOUT_PATH
                    : `${WORKLOAD_CHECKOUT_PATH}/${checked.workingFolder}`,
            environment,
            mounts: [
                ...mounts,
                {
                    kind: "folder",
                    source: request.outputDirectory,
                    target: WORKLOAD_OUTPUT_PATH,
                    writable: true,
                },
            ],
            ...(proxyAddress === null ? {} : { dns: [proxyAddress] }),
            ...(hosts.length === 0 ? {} : { hosts }),
        }),
    );
    if (!team.ok) {
        return workloadRefused(
            START_FAILED,
            `the workload container did not start: ${team.error.detail}`,
        );
    }
    return success(team.value);
}
