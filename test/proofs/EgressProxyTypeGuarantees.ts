// Compile-time guarantees of the egress proxy's types. Type-checked by `tsc`, never run; each line
// marked as an expected error must stay one:
//   - A TCP relay's host is a BareHost: a plain string is not one.
//   - A proxy starts only from rules that went through the parser: plain data is not ProxyRules.
//   - A proxy's optional ports accept undefined, so a caller can pass along what it was given.
//   - Parsed rules always hold their TCP relays, so nothing reading them needs a default.
import type { EgressPolicy } from "@revisum/contracts";
import {
    startEgressProxy,
    startProxyServer,
    type EgressProxyOptions,
    type ProxyRules,
} from "@revisum/runner";

type TcpRelay = ProxyRules["tcpRelays"][number];

declare const plainHost: string;
declare const policy: EgressPolicy;
declare const parsedRules: ProxyRules;

// @ts-expect-error a relay's host must be a BareHost, never a plain string
export const relayWithAPlainHost: TcpRelay = { host: plainHost, port: 5432, private: true };

// @ts-expect-error plain data, unread by the parser, cannot start a proxy
export const startedFromPlainRules = startProxyServer({
    allowedOrigins: [],
    privateOrigins: [],
    rewrites: [],
});

// What a proxy starts from, each of which type-checks.
export const egressProxyTypeGuarantees = {
    startsFromParsedRules: startProxyServer(parsedRules),
    relaysReadWithoutADefault: parsedRules.tcpRelays.length,
};

export const everyRelay: readonly TcpRelay[] = parsedRules.tcpRelays;

export const optionsWithPortsUndefined: EgressProxyOptions = {
    policy,
    resolve: undefined,
    connect: undefined,
};

export const portsUndefinedStart = startEgressProxy(optionsWithPortsUndefined);
