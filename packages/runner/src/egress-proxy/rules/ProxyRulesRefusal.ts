export const ProxyRulesRefusalCode = {
    NotJson: "not-json",
    NotAList: "not-a-list",
    NotAnOrigin: "not-an-origin",
    RewriteOriginNotRewritable: "rewrite-origin-not-rewritable",
    MalformedRewrite: "malformed-rewrite",
    EmptyFind: "empty-find",
    InvalidRelayHost: "invalid-relay-host",
    InvalidRelayPort: "invalid-relay-port",
    RelayPrivacyMissing: "relay-privacy-missing",
} as const;

export type ProxyRulesRefusalCode =
    (typeof ProxyRulesRefusalCode)[keyof typeof ProxyRulesRefusalCode];

// Why a rule was refused and where it is. No field repeats the value refused, which may hold a
// credential, so a refusal is safe to print.
export type ProxyRulesRefusal = {
    readonly code: ProxyRulesRefusalCode;
    // The list and the index of the rule, such as "allowedOrigins[1]".
    readonly path: string;
    readonly message: string;
};

const REASON_OF_CODE = {
    [ProxyRulesRefusalCode.NotJson]: "the egress proxy's rules are not JSON",
    [ProxyRulesRefusalCode.NotAList]: "this is not a list",
    [ProxyRulesRefusalCode.NotAnOrigin]: "this is not an origin the proxy can match",
    [ProxyRulesRefusalCode.RewriteOriginNotRewritable]:
        "a response rewrite may change only a declared plain-HTTP origin",
    [ProxyRulesRefusalCode.MalformedRewrite]:
        "this response rewrite is not a name, find and replace",
    [ProxyRulesRefusalCode.EmptyFind]: "this response rewrite has nothing to find",
    [ProxyRulesRefusalCode.InvalidRelayHost]: "this is not a host a TCP relay can connect to",
    [ProxyRulesRefusalCode.InvalidRelayPort]: "this TCP relay does not name a port",
    [ProxyRulesRefusalCode.RelayPrivacyMissing]:
        "this TCP relay does not say whether it is private",
} as const satisfies Record<ProxyRulesRefusalCode, string>;

export const proxyRulesRefusal = (
    code: ProxyRulesRefusalCode,
    path: string,
): ProxyRulesRefusal => ({ code, path, message: `${path}: ${REASON_OF_CODE[code]}` });
