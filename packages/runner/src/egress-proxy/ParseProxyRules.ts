import {
    failure,
    success,
    type DeclaredService,
    type EgressPolicy,
    type Origin,
    type Result,
} from "@revisum/contracts";
import { isIP } from "node:net";
import { isPlainHttpOrigin } from "../egress-events.ts";
import { bareHost, type BareHost } from "./BareHost.ts";
import { readExactOrigin } from "./ReadExactOrigin.ts";
import { ownField } from "./OwnField.ts";
import type { ParsedRewriteRule, ProxyRules } from "./ProxyRules.ts";
import { tcpRelaysFor, type TcpRelay } from "./TcpRelay.ts";

export type ProxyRulesRefusal = { readonly message: string };

type Parsed<Value> = Result<Value, ProxyRulesRefusal>;

const refused = (message: string): Parsed<never> => failure({ message });

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

function parseEach<Value>(
    values: unknown,
    listName: string,
    parseOne: (value: unknown) => Parsed<Value>,
): Parsed<readonly Value[]> {
    if (!isList(values)) {
        return refused(`${listName} is not a list`);
    }
    const parsed: Value[] = [];
    for (const value of values) {
        const one = parseOne(value);
        if (!one.ok) {
            return one;
        }
        parsed.push(one.value);
    }
    return success(parsed);
}

function parseOrigin(value: unknown): Parsed<Origin> {
    const origin = readExactOrigin(value);
    return origin === null
        ? refused(`${String(value)} is not an origin the proxy can match`)
        : success(origin);
}

function parseRewriteRule(value: unknown, allowed: ReadonlySet<string>): Parsed<ParsedRewriteRule> {
    const origin = parseOrigin(ownField(value, "origin"));
    if (!origin.ok) {
        return origin;
    }
    if (!allowed.has(origin.value) || !isPlainHttpOrigin(origin.value)) {
        return refused(
            `a response rewrite may change only a declared plain-HTTP origin, not ${origin.value}`,
        );
    }
    const rewrite = ownField(value, "rewrite");
    const name = ownField(rewrite, "name");
    const find = ownField(rewrite, "find");
    const replace = ownField(rewrite, "replace");
    if (typeof name !== "string" || typeof find !== "string" || typeof replace !== "string") {
        return refused(`the response rewrite on ${origin.value} is not a name, find and replace`);
    }
    return success({ origin: origin.value, rewrite: { name, find, replace } });
}

const RELAY_NAME = /^[A-Za-z0-9._-]{1,253}$/;
const LAST_PORT = 65_535;

// A DNS name or an IP address, an IPv6 one with or without its brackets, held bare.
function parseRelayHost(value: unknown): BareHost | null {
    if (typeof value !== "string") {
        return null;
    }
    const host = bareHost(value);
    const isNamed = RELAY_NAME.test(value);
    return isNamed || isIP(host) === 6 ? host : null;
}

function parseTcpRelay(value: unknown): Parsed<TcpRelay> {
    const rawHost = ownField(value, "host");
    const host = parseRelayHost(rawHost);
    const port = ownField(value, "port");
    const isPrivate = ownField(value, "private");
    if (host === null) {
        return refused(`${String(rawHost)} is not a host a TCP relay can connect to`);
    }
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > LAST_PORT) {
        return refused(`the TCP relay to ${host} does not name a port`);
    }
    if (typeof isPrivate !== "boolean") {
        return refused(`the TCP relay to ${host} does not say whether it is private`);
    }
    return success({ host, port, private: isPrivate });
}

// The proxy's rules from plain data, in one pass. A rule the proxy could not honour is refused here,
// with what was wrong with it, so a proxy only ever starts from rules it can keep.
export function parseProxyRules(raw: unknown): Parsed<ProxyRules> {
    const allowedOrigins = parseEach(
        ownField(raw, "allowedOrigins"),
        "allowedOrigins",
        parseOrigin,
    );
    if (!allowedOrigins.ok) {
        return allowedOrigins;
    }
    const privateOrigins = parseEach(
        ownField(raw, "privateOrigins"),
        "privateOrigins",
        parseOrigin,
    );
    if (!privateOrigins.ok) {
        return privateOrigins;
    }
    const allowed: ReadonlySet<string> = new Set(allowedOrigins.value);
    const rewrites = parseEach(ownField(raw, "rewrites"), "rewrites", (value) =>
        parseRewriteRule(value, allowed),
    );
    if (!rewrites.ok) {
        return rewrites;
    }
    const rules = {
        allowedOrigins: allowedOrigins.value,
        privateOrigins: privateOrigins.value,
        rewrites: rewrites.value,
    };
    const rawRelays = ownField(raw, "tcpRelays");
    if (rawRelays === undefined) {
        return success(rules as ProxyRules);
    }
    const tcpRelays = parseEach(rawRelays, "tcpRelays", parseTcpRelay);
    return tcpRelays.ok
        ? success({ ...rules, tcpRelays: tcpRelays.value } as ProxyRules)
        : tcpRelays;
}

// The proxy's rules from their JSON text, as its container receives them.
export function readProxyRules(text: string): Parsed<ProxyRules> {
    try {
        return parseProxyRules(JSON.parse(text));
    } catch {
        return refused("the egress proxy's rules are not JSON");
    }
}

// The proxy's rules for a policy: its origins, the origins of the services it allows, which of
// those services are private, its rewrites, and a TCP relay for each service it allows over TCP
// that declares a port. A policy built by hand can name what the parser refuses.
export function proxyRules(
    policy: EgressPolicy,
    services: readonly DeclaredService[] = [],
): Parsed<ProxyRules> {
    const allowedServices = services.filter((service) =>
        policy.allowServices.includes(service.name),
    );
    const tcpRelays = tcpRelaysFor(policy, services);
    return parseProxyRules({
        allowedOrigins: [
            ...new Set([
                ...policy.allowOrigins,
                ...allowedServices.map((service) => service.origin),
            ]),
        ],
        privateOrigins: allowedServices
            .filter((service) => service.private)
            .map((service) => service.origin),
        rewrites: policy.responseRewrites ?? [],
        ...(tcpRelays.length === 0 ? {} : { tcpRelays }),
    });
}
