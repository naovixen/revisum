import {
    failure,
    parseOrigin,
    success,
    type DeclaredService,
    type EgressPolicy,
    type Origin,
    type Result,
} from "@revisum/contracts";
import { isIP } from "node:net";
import { isPlainHttpOrigin } from "../../egress/JoinEgressEvents.ts";
import { bareHost, type BareHost } from "../addresses/BareHost.ts";
import { ownField } from "./OwnField.ts";
import type { ParsedRewriteRule, ProxyRules } from "./ProxyRules.ts";
import {
    ProxyRulesRefusalCode,
    proxyRulesRefusal,
    type ProxyRulesRefusal,
} from "./ProxyRulesRefusal.ts";
import { tcpRelaysFor, type TcpRelay } from "../tunnels/TcpRelay.ts";

type Parsed<Value> = Result<Value, ProxyRulesRefusal>;

// One rule read on its own: the list it is in supplies the rest of the refusal's path.
type ReadRule<Value> = Result<Value, ProxyRulesRefusalCode>;

const WHOLE_RULES_TEXT = "$";

const NO_TCP_RELAYS: readonly unknown[] = [];

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

function parseEach<Value>(
    values: unknown,
    listName: string,
    readOne: (value: unknown) => ReadRule<Value>,
): Parsed<readonly Value[]> {
    if (!isList(values)) {
        return failure(proxyRulesRefusal(ProxyRulesRefusalCode.NotAList, listName));
    }
    const parsed: Value[] = [];
    for (const [index, value] of values.entries()) {
        const one = readOne(value);
        if (!one.ok) {
            return failure(proxyRulesRefusal(one.error, `${listName}[${index}]`));
        }
        parsed.push(one.value);
    }
    return success(parsed);
}

function readRuleOrigin(value: unknown): ReadRule<Origin> {
    const origin = parseOrigin(value);
    return origin.ok ? origin : failure(ProxyRulesRefusalCode.NotAnOrigin);
}

function readRewriteRule(
    value: unknown,
    allowed: ReadonlySet<string>,
): ReadRule<ParsedRewriteRule> {
    const origin = readRuleOrigin(ownField(value, "origin"));
    if (!origin.ok) {
        return origin;
    }
    if (!allowed.has(origin.value) || !isPlainHttpOrigin(origin.value)) {
        return failure(ProxyRulesRefusalCode.RewriteOriginNotRewritable);
    }
    const rewrite = ownField(value, "rewrite");
    const name = ownField(rewrite, "name");
    const find = ownField(rewrite, "find");
    const replace = ownField(rewrite, "replace");
    if (typeof name !== "string" || typeof find !== "string" || typeof replace !== "string") {
        return failure(ProxyRulesRefusalCode.MalformedRewrite);
    }
    if (find === "") {
        return failure(ProxyRulesRefusalCode.EmptyFind);
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

function readTcpRelay(value: unknown): ReadRule<TcpRelay> {
    const host = parseRelayHost(ownField(value, "host"));
    const port = ownField(value, "port");
    const isPrivate = ownField(value, "private");
    if (host === null) {
        return failure(ProxyRulesRefusalCode.InvalidRelayHost);
    }
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > LAST_PORT) {
        return failure(ProxyRulesRefusalCode.InvalidRelayPort);
    }
    if (typeof isPrivate !== "boolean") {
        return failure(ProxyRulesRefusalCode.RelayPrivacyMissing);
    }
    return success({ host, port, private: isPrivate });
}

// The proxy's rules from plain data, in one pass. A rule the proxy could not honour is refused here,
// saying what kind of problem it is and where, so a proxy only ever starts from rules it can keep.
// Rules that leave out their TCP relays have none.
export function parseProxyRules(raw: unknown): Parsed<ProxyRules> {
    const allowedOrigins = parseEach(
        ownField(raw, "allowedOrigins"),
        "allowedOrigins",
        readRuleOrigin,
    );
    if (!allowedOrigins.ok) {
        return allowedOrigins;
    }
    const privateOrigins = parseEach(
        ownField(raw, "privateOrigins"),
        "privateOrigins",
        readRuleOrigin,
    );
    if (!privateOrigins.ok) {
        return privateOrigins;
    }
    const allowed: ReadonlySet<string> = new Set(allowedOrigins.value);
    const rewrites = parseEach(ownField(raw, "rewrites"), "rewrites", (value) =>
        readRewriteRule(value, allowed),
    );
    if (!rewrites.ok) {
        return rewrites;
    }
    const namedRelays = ownField(raw, "tcpRelays");
    const tcpRelays = parseEach(
        namedRelays === undefined ? NO_TCP_RELAYS : namedRelays,
        "tcpRelays",
        readTcpRelay,
    );
    if (!tcpRelays.ok) {
        return tcpRelays;
    }
    return success({
        allowedOrigins: allowedOrigins.value,
        privateOrigins: privateOrigins.value,
        rewrites: rewrites.value,
        tcpRelays: tcpRelays.value,
    } as ProxyRules);
}

function parseJsonText(text: string): Parsed<unknown> {
    try {
        const parsed: unknown = JSON.parse(text);
        return success(parsed);
    } catch {
        return failure(proxyRulesRefusal(ProxyRulesRefusalCode.NotJson, WHOLE_RULES_TEXT));
    }
}

// The proxy's rules from their JSON text, as its container receives them.
export function readProxyRules(text: string): Parsed<ProxyRules> {
    const json = parseJsonText(text);
    return json.ok ? parseProxyRules(json.value) : json;
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
        tcpRelays: tcpRelaysFor(policy, services),
    });
}
