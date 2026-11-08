// Starting the egress proxy in a test that expects it to start. A start gives an outcome, and a
// proxy's rules are plain data until the proxy's parser has read them, so a test that only needs a
// running proxy goes through here; a test of a refused start or refused rules calls the real thing.
import assert from "node:assert/strict";
import {
    parseProxyRules,
    readProxyRules,
    startEgressProxy,
    startProxyServer,
    type EgressProxy,
    type EgressProxyOptions,
    type ProxyRules,
    type ProxyServerOptions,
} from "@revisum/runner";

export function parsedProxyRules(rawRules: unknown): ProxyRules {
    const parsed = parseProxyRules(rawRules);
    assert.ok(parsed.ok, `the test's rules are accepted: ${JSON.stringify(parsed)}`);
    return parsed.value;
}

// The rules exactly as the proxy's container reads them, from the text of its environment variable.
export function proxyRulesFromText(text: string): ProxyRules {
    const read = readProxyRules(text);
    assert.ok(read.ok, `the test's rules are accepted: ${JSON.stringify(read)}`);
    return read.value;
}

export async function startedEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
    const started = await startEgressProxy(options);
    assert.ok(started.ok, `the proxy started: ${JSON.stringify(started)}`);
    return started.value;
}

export async function startedProxyServer(
    rawRules: unknown,
    options: ProxyServerOptions = {},
): Promise<EgressProxy> {
    const started = await startProxyServer(parsedProxyRules(rawRules), options);
    assert.ok(started.ok, `the proxy started: ${JSON.stringify(started)}`);
    return started.value;
}
