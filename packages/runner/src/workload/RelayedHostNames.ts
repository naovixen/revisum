import { isIP } from "node:net";
import { relayedServices } from "../egress-proxy/TcpRelay.ts";
import type { CheckedWorkloadRequest } from "./CheckWorkloadRequest.ts";

// The names the team's container resolves to the proxy, one per relayed service: the service's
// own name, and its origin's host when that is a name rather than an address.
export function relayedHostNames(checked: CheckedWorkloadRequest): readonly string[] {
    const names = relayedServices(checked.policy, checked.services).flatMap((service) => {
        const host = new URL(service.origin).hostname;
        return isIP(host.replace(/^\[(.*)\]$/, "$1")) === 0 ? [service.name, host] : [service.name];
    });
    return [...new Set<string>(names)];
}
