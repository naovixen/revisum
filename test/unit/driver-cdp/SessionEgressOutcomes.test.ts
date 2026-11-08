// A browser context's proxy decides where a session's traffic goes, and Chrome takes forms that send it
// somewhere else, or straight out. So only one http(s) address with a port is a proxy, and an egress
// that names anything else is closed again. What a close says is an answer, never a throw.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { failure, success, type Result } from "@revisum/contracts";
import { egressThroughExistingProxy, type SessionEgress } from "@revisum/driver-cdp";
import { openSessionEgress } from "../../../packages/driver-cdp/src/capabilities/SessionEgress.ts";

const WHY_IT_WOULD_NOT_CLOSE = "the listener would not close";
const CLOSED: Result<void, string> = success(undefined);

const NOT_A_PROXY: readonly { readonly name: string; readonly server: string }[] = [
    { name: "blank", server: " " },
    { name: "the direct route", server: "direct://" },
    { name: "a socks proxy", server: "socks5://proxy.test:1080" },
    { name: "a list of proxies", server: "http://a.test:1;http://b.test:2" },
    { name: "a PAC-style entry", server: "PROXY proxy.test:3128" },
    { name: "a host with no scheme", server: "proxy.test:3128" },
    { name: "an address with no port", server: "http://proxy.test" },
];

const PROXIES: readonly string[] = [
    "http://127.0.0.1:9",
    "https://proxy.test:3128",
    "http://egress-proxy:3128",
];

function egressNaming(context: TestContext, server: string, closed: Result<void, string> = CLOSED) {
    const close = context.mock.fn(() => Promise.resolve(closed));
    const egress: SessionEgress = {
        proxy: { server, includeLoopback: false },
        refusedOrigins: () => success([]),
        connectionFailures: () => [],
        close,
    };
    return { close, source: () => Promise.resolve(success(egress)) };
}

describe("Using a session's egress", () => {
    for (const { name, server } of NOT_A_PROXY) {
        describe(`given a source whose proxy value is ${name}`, () => {
            describe("when the egress is opened", () => {
                test("then it should refuse it and close what was started", async (context) => {
                    const { close, source } = egressNaming(context, server);

                    const opened = await openSessionEgress(source, []);

                    assert.equal(opened.ok, false, JSON.stringify(opened));
                    assert.equal(close.mock.callCount(), 1);
                });
            });
        });
    }

    for (const server of PROXIES) {
        describe(`given a source whose proxy is ${server}`, () => {
            describe("when the egress is opened", () => {
                test("then it should give that proxy to the browser context", async (context) => {
                    const { close, source } = egressNaming(context, server);

                    const opened = await openSessionEgress(source, []);

                    assert.ok(opened.ok, JSON.stringify(opened));
                    assert.equal(opened.value.contextProxy.proxyServer, server);
                    assert.equal(close.mock.callCount(), 0);
                });
            });
        });
    }

    describe("given a proxy value that is refused", () => {
        describe("and an egress whose close answers with a failure", () => {
            describe("when the egress is opened", () => {
                test("then it should say both why and what the close said", async (context) => {
                    const { source } = egressNaming(
                        context,
                        "direct://",
                        failure(WHY_IT_WOULD_NOT_CLOSE),
                    );

                    const opened = await openSessionEgress(source, []);

                    assert.ok(!opened.ok, JSON.stringify(opened));
                    assert.match(opened.error, new RegExp(WHY_IT_WOULD_NOT_CLOSE));
                });
            });
        });
    });

    describe("given the egress of a proxy something else runs", () => {
        describe("when it closes", () => {
            test("then it should answer that it closed", async () => {
                const started = await egressThroughExistingProxy("http://proxy.test:3128")([]);
                assert.ok(started.ok, JSON.stringify(started));

                assert.deepEqual(await started.value.close(), CLOSED);
            });
        });
    });
});
