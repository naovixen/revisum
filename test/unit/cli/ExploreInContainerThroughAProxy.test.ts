// The counter-example to a crawl refusing to run with no proxy: with HTTP_PROXY set, the same entry module
// starts a real headless browser and prints a page map, as it does in a run container. An isolated
// session sends loopback direct, so the site here is reached without the proxy; what the proxy lets
// through is proved in the container tests.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CONTAINER_EXIT } from "../../../packages/cli/src/explore-crawl.ts";
import { ProxyClient, startProxyServer, type EgressProxy } from "@revisum/runner";
import { BROWSERS } from "../../support/browsers.ts";
import { startFixtureServer, type FixtureServer } from "../../support/fixture-server.ts";
import { FIXTURES } from "../../support/repository.ts";
import {
    CRAWL_BOUNDS,
    HTTP_PROXY_VARIABLE,
    crawlProjectFile,
    runExploreInContainer,
    type CrawlProcess,
} from "./RunExploreInContainer.ts";

let site: FixtureServer;
let proxy: EgressProxy;

before(async () => {
    site = await startFixtureServer(join(FIXTURES, "explore-site"));
    proxy = await startProxyServer(
        { allowedOrigins: [site.origin], privateOrigins: [site.origin], rewrites: [] },
        { client: ProxyClient.Browser },
    );
});
after(async () => {
    await proxy.close();
    await site.close();
});

describe("Using the crawl's entry module", () => {
    describe("given HTTP_PROXY names a running proxy", () => {
        describe("and a site the project allows", () => {
            describe("when the crawl runs", () => {
                let crawl: CrawlProcess;
                before(async () => {
                    crawl = await runExploreInContainer(
                        {
                            project: crawlProjectFile(site.origin),
                            start: `${site.origin}/`,
                            browserPath: BROWSERS.chrome,
                            ...CRAWL_BOUNDS,
                        },
                        { [HTTP_PROXY_VARIABLE]: proxy.url },
                    );
                });

                test("then it should exit as mapped", () => {
                    assert.equal(crawl.exitCode, CONTAINER_EXIT.mapped, crawl.stderr);
                });

                test("then it should print a page map of the site's start page", () => {
                    assert.ok(crawl.stdout.includes(site.origin), crawl.stdout);
                });
            });
        });
    });
});
