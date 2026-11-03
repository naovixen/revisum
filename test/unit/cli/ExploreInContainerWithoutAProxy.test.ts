// In a run container the crawl's only way out is the egress proxy that HTTP_PROXY names, so with none it
// must refuse rather than run a browser behind nothing. Nothing about this check needs a container or a
// browser: the browser path named here does not exist, so the crawl stops at the first thing it does
// after the check, which is what tells the two stops apart.
import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import { CONTAINER_EXIT } from "../../../packages/cli/src/explore-crawl.ts";
import { REPOSITORY_ROOT } from "../../support/repository.ts";
import {
    CRAWL_BOUNDS,
    HTTP_PROXY_VARIABLE,
    crawlProjectFile,
    runExploreInContainer,
    type CrawlProcess,
} from "./RunExploreInContainer.ts";

const ORIGIN = "http://127.0.0.1:9";
const MISSING_BROWSER = join(REPOSITORY_ROOT, "no-such-folder", "no-such-browser");
const SAYS_THERE_IS_NO_PROXY = new RegExp(HTTP_PROXY_VARIABLE);

const crawlInput = {
    project: crawlProjectFile(ORIGIN),
    start: `${ORIGIN}/`,
    browserPath: MISSING_BROWSER,
    ...CRAWL_BOUNDS,
};

const CASES_WITH_NO_PROXY: readonly {
    readonly name: string;
    readonly environment: Readonly<Record<string, string>>;
}[] = [
    { name: "unset", environment: {} },
    { name: "empty", environment: { [HTTP_PROXY_VARIABLE]: "" } },
];

describe("Using the crawl's entry module", () => {
    for (const { name, environment } of CASES_WITH_NO_PROXY) {
        describe(`given HTTP_PROXY is ${name}`, () => {
            describe("when the crawl starts", () => {
                let crawl: CrawlProcess;
                before(async () => {
                    crawl = await runExploreInContainer(crawlInput, environment);
                });

                test("then it should exit as failed", () => {
                    assert.equal(crawl.exitCode, CONTAINER_EXIT.failed, crawl.stderr);
                });

                test("then it should say the proxy is why", () => {
                    assert.match(crawl.stderr, SAYS_THERE_IS_NO_PROXY);
                });

                test("then it should print no page map", () => {
                    assert.equal(crawl.stdout, "");
                });
            });
        });
    }

    describe("given HTTP_PROXY names a proxy", () => {
        describe("when the crawl starts", () => {
            let crawl: CrawlProcess;
            before(async () => {
                crawl = await runExploreInContainer(crawlInput, {
                    [HTTP_PROXY_VARIABLE]: "http://127.0.0.1:9",
                });
            });

            test("then it should go on past the check, and stop only at the missing browser", () => {
                assert.equal(crawl.exitCode, CONTAINER_EXIT.failed, crawl.stderr);
                assert.doesNotMatch(crawl.stderr, SAYS_THERE_IS_NO_PROXY);
                assert.notEqual(crawl.stderr, "");
            });
        });
    });
});
