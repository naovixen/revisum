// A session reads what the proxy refused through refusedOrigins: the origin of every blocked decision,
// plain requests and tunnels alike, in the order refused, and not one it let through.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type EgressProxy } from "@revisum/runner";
import { startedProxyServer } from "#test-support/StartedEgressProxy.ts";
import {
    exchangeWithProxy,
    plainRequestText,
    startUpstream,
    tunnelRequestText,
    type Upstream,
} from "../unit/runner/proxy-requests.ts";
import { fakeResolver } from "../unit/runner/runner-examples.ts";

const ALLOWED = "http://allowed.test";

describe("Using the egress proxy", () => {
    describe("given a running proxy with one allowed origin", () => {
        let upstream: Upstream;
        let proxy: EgressProxy;

        before(async () => {
            upstream = await startUpstream();
            proxy = await startedProxyServer(
                { allowedOrigins: [ALLOWED], privateOrigins: [], rewrites: [] },
                {
                    resolve: fakeResolver({ "allowed.test": ["93.184.215.14"] }).resolve,
                    connect: (address, port) => upstream.connect(address, port),
                },
            );
        });
        after(async () => {
            await proxy.close();
            await upstream.close();
        });

        describe("when it refuses a plain request and a tunnel and lets one through", () => {
            test("then it should list only what it refused, in order", async () => {
                await exchangeWithProxy(proxy.url, plainRequestText("http://refused.test"));
                await exchangeWithProxy(proxy.url, plainRequestText(ALLOWED));
                await exchangeWithProxy(proxy.url, tunnelRequestText("refused.test:443"));
                assert.deepEqual(proxy.refusedOrigins(), [
                    "http://refused.test",
                    "refused.test:443",
                ]);
            });
        });
    });
});
