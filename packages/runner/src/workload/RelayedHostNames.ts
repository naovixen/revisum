import type { WorkloadRequest } from "@revisum/contracts";
import { isIP } from "node:net";

// The names the team's container resolves to the proxy, one per relayed service: the service's
// own name, and its origin's host when that is a name rather than an address.
export function relayedHostNames(request: WorkloadRequest): readonly string[] {
    const relayed = (request.services ?? []).filter(
        (service) =>
            request.policy.allowTcpServices.includes(service.name) && service.port !== undefined,
    );
    const names = relayed.flatMap((service) => {
        const host = new URL(service.origin).hostname;
        return isIP(host.replace(/^\[(.*)\]$/, "$1")) === 0 ? [service.name, host] : [service.name];
    });
    return [...new Set<string>(names)];
}
