// The team's container, joined to the run's network and nothing else, with the checkout read-only and
// the output folder as its only writable mount.
import {
    WORKLOAD_CHECKOUT_PATH,
    WORKLOAD_OUTPUT_PATH,
    success,
    type Result,
} from "@revisum/contracts";
import type { ContainerEngine, HostEntry } from "../../containers/ContainerEngine.ts";
import type { ContainerScope } from "../../containers/ContainerScope.ts";
import { proxyUrl } from "../../containers/RunImageContainer.ts";
import type { StartedProxy } from "../../egress/StartProxyContainer.ts";
import { workloadEnvironment } from "../WorkloadEnvironment.ts";
import { checkoutMounts } from "./CheckoutMounts.ts";
import type { CheckedWorkloadRequest } from "../CheckWorkloadRequest.ts";
import { readyOutputFolder } from "../output/ReadyOutputFolder.ts";
import { relayedHostNames } from "../RelayedHostNames.ts";
import { teamImageContainer } from "./TeamImageContainer.ts";
import { workloadRefused, type WorkloadLog, type WorkloadRefusal } from "../WorkloadRefusal.ts";

type TeamContainerFields = {
    readonly engine: ContainerEngine;
    readonly root: string;
    readonly checkout: string;
    readonly log: WorkloadLog;
};

const START_FAILED = "workload-start-failed";
const UNENFORCEABLE = "egress-unenforceable";

// The id of the started container.
export async function startTeamContainer(
    scope: ContainerScope,
    fields: TeamContainerFields,
    checked: CheckedWorkloadRequest,
    proxy: StartedProxy,
): Promise<Result<string, WorkloadRefusal>> {
    const { engine, root, checkout, log } = fields;
    const environment = workloadEnvironment(
        checked.environment,
        proxyUrl(proxy.name),
        checked.hasHttpProxyVariables,
    );
    const mounts = checkoutMounts(checkout, log);
    if (mounts === null) {
        return workloadRefused(START_FAILED, "the checkout cannot be read");
    }
    if (!readyOutputFolder(checked.outputDirectory)) {
        return workloadRefused(START_FAILED, "the output folder cannot be made writable");
    }
    const imageUser = await engine.imageUser(checked.image);
    if (!imageUser.ok) {
        return workloadRefused(
            UNENFORCEABLE,
            `the image's user could not be read: ${imageUser.error.detail}`,
        );
    }
    // Lookups go to the proxy, which is how a process that ignores it is seen, and a relayed service
    // is reached by name at it: no team container starts without knowing where it is.
    const proxyAddress = await engine.containerAddress(proxy.id, scope.network);
    if (!proxyAddress.ok) {
        return workloadRefused(
            UNENFORCEABLE,
            `the proxy's address could not be read: ${proxyAddress.error.detail}`,
        );
    }
    const hosts: HostEntry[] = relayedHostNames(checked).map((name) => ({
        name,
        address: proxyAddress.value,
    }));

    const team = await scope.startContainer(
        teamImageContainer(root, imageUser.value, {
            name: `${scope.runId}-workload`,
            image: checked.image,
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
                    source: checked.outputDirectory,
                    target: WORKLOAD_OUTPUT_PATH,
                    writable: true,
                },
            ],
            dns: [proxyAddress.value],
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
