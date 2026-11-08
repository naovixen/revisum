import type { DeclaredService, EgressPolicy } from "@revisum/contracts";
import type { EgressProxy } from "./EgressProxy.ts";
import { proxyRules } from "./ProxyRules.ts";
import { startProxyServer, type ProxyServerOptions } from "./StartProxyServer.ts";

export type EgressProxyOptions = ProxyServerOptions & {
    readonly policy: EgressPolicy;
    // The project's declared services; only those the policy allows are reachable.
    readonly services?: readonly DeclaredService[];
};

// Starts a proxy that enforces a policy. See startProxyServer for what rejects.
export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
    return startProxyServer(proxyRules(options.policy, options.services), options);
}
