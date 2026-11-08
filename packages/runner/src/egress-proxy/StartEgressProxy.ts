import { failure, type DeclaredService, type EgressPolicy, type Result } from "@revisum/contracts";
import type { EgressProxy } from "./EgressProxy.ts";
import { proxyRules } from "./ParseProxyRules.ts";
import { ProxyStartFailureCode, type ProxyStartFailure } from "./ProxyStartFailure.ts";
import { startProxyServer, type ProxyServerOptions } from "./StartProxyServer.ts";

export type EgressProxyOptions = ProxyServerOptions & {
    readonly policy: EgressPolicy;
    // The project's declared services; only those the policy allows are reachable.
    readonly services?: readonly DeclaredService[] | undefined;
};

// Starts a proxy that enforces a policy. A policy built by hand can name what the parser refuses.
export async function startEgressProxy(
    options: EgressProxyOptions,
): Promise<Result<EgressProxy, ProxyStartFailure>> {
    const rules = proxyRules(options.policy, options.services);
    return rules.ok
        ? startProxyServer(rules.value, options)
        : failure({ code: ProxyStartFailureCode.RulesRefused, message: rules.error.message });
}
