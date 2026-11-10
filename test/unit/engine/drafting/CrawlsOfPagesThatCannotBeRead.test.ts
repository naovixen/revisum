// A page that loads and then can't be read counts as one that did not load, so nothing of it is kept:
// a start page stops the crawl, and any other is left out. Unlike a page that never loaded, this one is
// there and the map lacks it and its links, so the map says it is truncated.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { PageReadFailureCode, type TrustedProject } from "@revisum/engine";
import { trustedProjectFrom } from "../../../support/builders/ClearRun.ts";
import {
    at,
    crawlProjectFile,
    crawlSite,
    fakeSite,
    optionsFor,
    spyExploreDriver,
    type FakePage,
    type PageRead,
} from "./examples/CrawlOutcome.ts";

const READS: readonly PageRead[] = ["page", "accessibilitySnapshot", "linkTargets"];

const ROOM_FOR_THE_WHOLE_SITE = { maximumPages: 100, maximumDepth: 5 };

let project: TrustedProject;
before(async () => {
    project = await trustedProjectFrom(crawlProjectFile());
});

const crawlOf = (pages: Readonly<Record<string, FakePage>>, bounds = ROOM_FOR_THE_WHOLE_SITE) =>
    crawlSite(spyExploreDriver(fakeSite(pages)).driver, project, optionsFor(at("/"), bounds));

const failingOn = (read: PageRead, code: PageReadFailureCode) => ({
    read,
    code,
});

describe("Using a crawl of a site", () => {
    for (const read of READS) {
        for (const code of Object.values(PageReadFailureCode)) {
            describe(`given the ${read} read of the start page fails with ${code}`, () => {
                describe("when the site is crawled", () => {
                    test("then it should stop with explore-start-unreachable", async () => {
                        const outcome = await crawlOf({
                            [at("/")]: {
                                title: "Home",
                                links: [at("/a.html")],
                                failingRead: failingOn(read, code),
                            },
                            [at("/a.html")]: { title: "A", links: [] },
                        });
                        assert.deepEqual(outcome, {
                            ok: false,
                            code: "explore-start-unreachable",
                        });
                    });
                });
            });

            describe(`given the ${read} read of a later page fails with ${code}`, () => {
                const site = {
                    [at("/")]: { title: "Home", links: [at("/a.html"), at("/b.html")] },
                    [at("/a.html")]: {
                        title: "Held",
                        links: [at("/only-from-a.html")],
                        failingRead: failingOn(read, code),
                    },
                    [at("/b.html")]: { title: "B", links: [] },
                    [at("/only-from-a.html")]: { title: "Only from A", links: [] },
                };

                describe("when the site is crawled", () => {
                    test("then it should leave that page and its links out, keep the rest and mark the map truncated", async () => {
                        const outcome = await crawlOf(site);
                        assert.ok(outcome.ok, JSON.stringify(outcome));
                        assert.deepEqual(
                            outcome.map.pages.map((page) => page.path),
                            ["/", "/b.html"],
                        );
                        assert.equal(outcome.map.truncated, true);
                    });
                });

                describe("and a page bound with room only for the pages it can read", () => {
                    describe("when the site is crawled", () => {
                        test("then it should not count that page against the bound", async () => {
                            const outcome = await crawlOf(site, {
                                maximumPages: 2,
                                maximumDepth: 5,
                            });
                            assert.ok(outcome.ok, JSON.stringify(outcome));
                            assert.deepEqual(
                                outcome.map.pages.map((page) => page.path),
                                ["/", "/b.html"],
                            );
                        });
                    });
                });
            });
        }
    }
});
