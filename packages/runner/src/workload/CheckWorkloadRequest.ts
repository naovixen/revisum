// A workload request read before any container starts: what it asks for is possible on this host.
import { success, type Result, type WorkloadRequest } from "@revisum/contracts";
import { isAbsolute } from "node:path";
import { relayOrigin, tcpRelaysFor } from "../egress-proxy/TcpRelay.ts";
import { PROXY_PORT } from "../proxy-container.ts";
import { repositoryFolder } from "../run-containers.ts";
import { isSafeInMountArgument } from "./IsSafeInMountArgument.ts";
import { workloadRefused, type WorkloadRefusal } from "./WorkloadRefusal.ts";

// Each stream is cut here, so a chatty suite cannot exhaust memory or bloat what is kept.
const OUTPUT_LIMIT_BYTES = 1024 * 1024;

const START_FAILED = "workload-start-failed";

export type CheckedWorkloadRequest = {
    // Inside the checkout, or empty for the checkout's own root.
    readonly workingFolder: string;
    readonly outputLimit: number;
    readonly relayedOrigins: ReadonlySet<string>;
};

export function checkWorkloadRequest(
    request: WorkloadRequest,
    checkout: string,
    root: string,
): Result<CheckedWorkloadRequest, WorkloadRefusal> {
    const workingFolder =
        request.workingDirectory === "." ? "" : repositoryFolder(request.workingDirectory);
    if (workingFolder === null) {
        return workloadRefused(
            START_FAILED,
            "the working directory is not a folder inside the checkout",
        );
    }
    if (request.argv.length === 0) {
        return workloadRefused(START_FAILED, "the argument vector is empty");
    }
    if (!Number.isFinite(request.timeoutMilliseconds) || request.timeoutMilliseconds <= 0) {
        return workloadRefused(
            START_FAILED,
            "the timeout is not a positive number of milliseconds",
        );
    }
    const hasMountablePaths =
        isAbsolute(request.outputDirectory) &&
        isSafeInMountArgument(request.outputDirectory) &&
        isSafeInMountArgument(checkout) &&
        isSafeInMountArgument(root);
    if (!hasMountablePaths) {
        return workloadRefused(
            START_FAILED,
            "the output folder, checkout or repository path cannot be mounted",
        );
    }
    const outputLimit = request.maximumOutputBytes ?? OUTPUT_LIMIT_BYTES;
    if (!Number.isSafeInteger(outputLimit) || outputLimit < 0) {
        return workloadRefused(START_FAILED, "the output limit is not a whole number of bytes");
    }
    // Each relay listens on its service's own port, so two cannot share one, nor take the proxy's.
    const relays = tcpRelaysFor(request.policy, request.services ?? []);
    const relayPorts = relays.map((relay) => relay.port);
    if (new Set(relayPorts).size !== relayPorts.length || relayPorts.includes(PROXY_PORT)) {
        return workloadRefused(
            START_FAILED,
            "two services allowed over TCP share a port, or one uses the proxy's own port",
        );
    }
    return success({
        workingFolder,
        outputLimit,
        relayedOrigins: new Set(relays.map(relayOrigin)),
    });
}
