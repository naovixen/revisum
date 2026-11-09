// A workload request read before any container starts: what it asks for is possible on this host.
import {
    success,
    type Brand,
    type DeclaredService,
    type EgressPolicy,
    type ImageDigest,
    type Result,
    type WorkloadRequest,
} from "@revisum/contracts";
import { relayOrigin, tcpRelaysFor } from "../egress-proxy/tunnels/TcpRelay.ts";
import { PROXY_PORT } from "../egress/StartRecordKeeping.ts";
import { readVariableName } from "../containers/ReadVariableName.ts";
import { repositoryFolder } from "../containers/RunImageContainer.ts";
import type { CheckedVariable } from "./WorkloadEnvironment.ts";
import { areMountablePaths } from "./team-container/AreMountablePaths.ts";
import { workloadRefused, type WorkloadRefusal } from "./WorkloadRefusal.ts";

// Each stream is cut here, so a chatty suite cannot exhaust memory or bloat what is kept.
const OUTPUT_LIMIT_BYTES = 1024 * 1024;

const START_FAILED = "workload-start-failed";

// The longest wait a Node timer can hold; anything longer fires at once.
const LONGEST_TIMER_MILLISECONDS = 2_147_483_647;

// A request every later step can trust: nothing about it has to be checked again.
export type CheckedWorkloadRequest = Brand<
    {
        readonly image: ImageDigest;
        readonly argv: readonly string[];
        // Inside the checkout, or empty for the checkout's own root.
        readonly workingFolder: string;
        readonly environment: readonly CheckedVariable[];
        readonly policy: EgressPolicy;
        readonly timeoutMilliseconds: number;
        readonly outputDirectory: string;
        readonly services: readonly DeclaredService[];
        readonly hasHttpProxyVariables: boolean;
        readonly outputLimit: number;
        readonly relayedOrigins: ReadonlySet<string>;
    },
    "CheckedWorkloadRequest"
>;

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
    if (
        !Number.isFinite(request.timeoutMilliseconds) ||
        request.timeoutMilliseconds <= 0 ||
        request.timeoutMilliseconds > LONGEST_TIMER_MILLISECONDS
    ) {
        return workloadRefused(
            START_FAILED,
            "the timeout is not a positive number of milliseconds a timer can hold",
        );
    }
    const environment = checkedEnvironment(request.environment);
    if (environment === null) {
        return workloadRefused(
            START_FAILED,
            "a declared variable has a name an environment cannot hold",
        );
    }
    if (!areMountablePaths(request.outputDirectory, [checkout, root])) {
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
    const services = request.services ?? [];
    const relays = tcpRelaysFor(request.policy, services);
    const relayPorts = relays.map((relay) => relay.port);
    if (new Set(relayPorts).size !== relayPorts.length || relayPorts.includes(PROXY_PORT)) {
        return workloadRefused(
            START_FAILED,
            "two services allowed over TCP share a port, or one uses the proxy's own port",
        );
    }
    return success({
        image: request.image,
        argv: request.argv,
        workingFolder,
        environment,
        policy: request.policy,
        timeoutMilliseconds: request.timeoutMilliseconds,
        outputDirectory: request.outputDirectory,
        services,
        hasHttpProxyVariables: request.httpProxyVariables !== false,
        outputLimit,
        relayedOrigins: new Set(relays.map(relayOrigin)),
    } as unknown as CheckedWorkloadRequest);
}

// Each variable with its name read, or null when one cannot be held by an environment.
function checkedEnvironment(
    declared: WorkloadRequest["environment"],
): readonly CheckedVariable[] | null {
    const checked: CheckedVariable[] = [];
    for (const variable of declared) {
        const name = readVariableName(variable.name);
        if (name === null) {
            return null;
        }
        checked.push({ name, value: variable.value });
    }
    return checked;
}
