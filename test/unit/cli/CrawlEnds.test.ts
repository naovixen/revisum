// How a crawl ends when what it runs on misbehaves: a browser session whose close never answers is
// given up on within the same deadline the run itself uses, and said so; an engine that could not run
// the crawl is told apart from a crawl that ran and crashed.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { crawlInBrowser, crawlInRunner, type ContainerCrawlInput } from "@revisum/cli";
import { CONTAINER_EXIT } from "../../../packages/cli/src/explore-crawl.ts";
import {
    failure,
    success,
    type ExploreOptions,
    type ImageDigest,
    type Origin,
    type Result,
    type Session,
} from "@revisum/engine";
import type { ExecOutcome } from "@revisum/contracts";
import { fakeDriverOpening } from "#test-support/fakes/FakeDriver.ts";
import { fakeEventSink } from "#test-support/fakes/FakeEventSink.ts";
import { fakeRedactor } from "#test-support/fakes/FakeRedactor.ts";
import { fakeRunEnding, fakeRunner } from "#test-support/fakes/FakeRunner.ts";
import { fakeRunnerHandle } from "#test-support/fakes/FakeRunnerHandle.ts";
import { fakeSecretStore } from "#test-support/fakes/FakeSecretStore.ts";
import { fakeSession } from "#test-support/fakes/FakeSession.ts";
import { ORIGIN } from "../engine/plan-examples.ts";
import {
    projectWith,
    targetInput,
    targetOf,
    trustedProjectWith,
} from "../engine/target-examples.ts";

const SAME_DEADLINE_MILLISECONDS = 60_000;
const DESKTOP = targetInput("chromium-desktop", "fake-any", "chromium", "desktop-1280");
const OPTIONS: ExploreOptions = {
    start: `${ORIGIN}/`,
    maximumPages: 1,
    maximumDepth: 0,
    pageTimeoutMilliseconds: 1000,
    placement: "host",
};
const PENDING = "still waiting";

const manyTurns = async (): Promise<void> => {
    for (let turn = 0; turn < 10; turn += 1) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
};

async function crawlOn(session: Session): ReturnType<typeof crawlInBrowser> {
    const trusted = await trustedProjectWith([DESKTOP]);
    return crawlInBrowser(fakeDriverOpening(session), {
        project: projectWith([DESKTOP]),
        target: targetOf(trusted, "chromium-desktop"),
        options: OPTIONS,
        redactor: fakeRedactor(),
        secrets: fakeSecretStore(),
        audit: fakeEventSink(),
    });
}

// Waits for the session's close to be asked for, then lets the deadline pass, and says what the crawl
// answered by then. The wedged close never answers, so a crawl that keeps waiting stays pending.
async function crawlWithWedgedClose(
    context: TestContext,
    extras: Partial<Session> = {},
    ticks: readonly number[] = [SAME_DEADLINE_MILLISECONDS],
): Promise<unknown> {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let closeAsked = (): void => undefined;
    const closing = new Promise<void>((resolve) => {
        closeAsked = resolve;
    });
    const session = fakeSession({
        page: () =>
            Promise.resolve(
                success({ url: `${ORIGIN}/`, title: "Home", meta: [], canonicalUrl: null }),
            ),
        close: () => {
            closeAsked();
            return new Promise(() => undefined);
        },
        ...extras,
    });
    const crawling = crawlOn(session).catch((error: unknown) => ({ rejected: error }));
    // A crawl that ended before its close was asked for must not hang the test, so either ends the wait.
    await Promise.race([closing, crawling]);
    for (const milliseconds of ticks) {
        await manyTurns();
        context.mock.timers.tick(milliseconds);
    }
    await manyTurns();
    return Promise.race([crawling, Promise.resolve(PENDING)]);
}

describe("Using the crawl in a browser", () => {
    describe("given a session whose close never answers", () => {
        describe("when the crawl has finished and the deadline passes", () => {
            test("then it should end, saying the close did not finish", async (context) => {
                const ended = await crawlWithWedgedClose(context);
                assert.notEqual(ended, PENDING, "the crawl was still waiting on a wedged close");
                const { closeFailure } = ended as { readonly closeFailure: unknown };
                assert.equal(typeof closeFailure, "string", JSON.stringify(ended));
                assert.notEqual(closeFailure, "");
            });
        });

        describe("when the deadline has not yet passed", () => {
            test("then it should still be waiting", async (context) => {
                const ended = await crawlWithWedgedClose(context, {}, [SAME_DEADLINE_MILLISECONDS - 1]);
                assert.equal(ended, PENDING);
            });
        });

        describe("and a crawl that throws", () => {
            describe("when the deadline passes", () => {
                test("then it should end, carrying the crawl's error and the unfinished close", async (context) => {
                    const crawlError = "the driver broke while reading the page";
                    const ended = await crawlWithWedgedClose(context, {
                        page: () => Promise.reject(new Error(crawlError)),
                    });
                    assert.notEqual(
                        ended,
                        PENDING,
                        "the crawl was still waiting on a wedged close",
                    );
                    assert.ok(
                        typeof ended === "object" && ended !== null && "rejected" in ended,
                        JSON.stringify(ended),
                    );
                    assert.ok(String(ended.rejected).includes(crawlError), String(ended.rejected));
                });
            });
        });
    });
});

const ORIGIN_TEXT = "http://app.test";
const SITE: Origin = ORIGIN_TEXT as Origin;
const INPUT: ContainerCrawlInput = {
    project: {},
    start: `${ORIGIN_TEXT}/`,
    maximumPages: 1,
    maximumDepth: 0,
    pageTimeoutMilliseconds: 1000,
};
const IMAGE = `sha256:${"a".repeat(64)}` as ImageDigest;

const crawlAnswering = (answer: Result<ExecOutcome, { readonly detail: string }>) =>
    crawlInRunner(
        {
            runner: fakeRunner({
                withRun: (image, policy, use) =>
                    fakeRunEnding(
                        fakeRunnerHandle({
                            guaranteeLevel: () => "isolated",
                            exec: () => Promise.resolve(answer),
                        }),
                        use,
                    ),
            }),
            image: IMAGE,
        },
        INPUT,
        SITE,
        [],
        fakeRedactor(),
    );

describe("Using the crawl in a run container", () => {
    describe("given an engine that could not run the crawl", () => {
        describe("when the crawl is asked for", () => {
            test("then it should say the runner was unavailable", async () => {
                const crawled = await crawlAnswering(failure({ detail: "the daemon is gone" }));
                assert.deepEqual(crawled, failure("explore-runner-unavailable"));
            });
        });
    });

    describe("given a crawl that ran and crashed", () => {
        describe("when the crawl is asked for", () => {
            test("then it should say the crawl crashed, not the runner", async () => {
                const crawled = await crawlAnswering(
                    success({ exitCode: CONTAINER_EXIT.failed, stdout: "", stderr: "crashed" }),
                );
                assert.deepEqual(crawled, failure("explore-crawl-crashed"));
            });
        });
    });
});
