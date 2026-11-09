// A crawl with a login plan runs on the login's own project and target: its session is opened for
// the target the login was cleared for, and the login runs in that same session, so what it signs
// in to is what the crawl reads.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildAdapters, crawlInBrowser } from "@revisum/cli";
import { failure, success, type ExploreOptions, type Session, type Target } from "@revisum/engine";
import { clearRun } from "#test-support/builders/ClearRun.ts";
import { fakeDriverOpening } from "#test-support/fakes/session/FakeDriver.ts";
import { fakeEventSink } from "#test-support/fakes/ports/FakeEventSink.ts";
import { fakeRedactor } from "#test-support/fakes/ports/FakeRedactor.ts";
import { fakeSecretStore } from "#test-support/fakes/ports/FakeSecretStore.ts";
import {
    closedSession,
    fakeSession,
    type FakeSession,
} from "#test-support/fakes/session/FakeSession.ts";
import { ORIGIN } from "../../engine/plan/examples/GoldenPlan.ts";
import { parsedPlan } from "../../engine/secrets/examples/SecretRun.ts";
import {
    projectWith,
    targetInput,
    targetOf,
    trustedProjectWith,
} from "../../engine/target/examples/TargetOf.ts";
import { DriverErrorCode, GuaranteeLevel } from "@revisum/contracts";

const DESKTOP = targetInput("chromium-desktop", "fake-any", "chromium", "desktop-1280");
const TABLET = targetInput("chromium-tablet", "fake-any", "chromium", "tablet-820");
const MATRIX = [DESKTOP, TABLET];

const OPTIONS: ExploreOptions = {
    start: `${ORIGIN}/`,
    maximumPages: 1,
    maximumDepth: 0,
    pageTimeoutMilliseconds: 1000,
    placement: GuaranteeLevel.Host,
};

// A login plan on the tablet target only: the matrix's second target, never the crawl's default.
const LOGIN_PLAN = {
    version: "1.3",
    meta: { featureId: "LOGIN-1", specReference: "specs/login.md", title: "Sign in" },
    targets: ["chromium-tablet"],
    steps: [
        { type: "navigate", url: "/" },
        {
            type: "expect",
            locator: { by: "testId", testId: "status" },
            assert: { kind: "visible" },
            criterionId: "login.status-shown",
        },
    ],
};

const WHY_THE_CLOSE_FAILED = "the crawl's profile folder is still held";
const WHY_THE_CRAWL_THREW = "the driver broke while reading the page";

const THE_HOME_PAGE = {
    url: `${ORIGIN}/`,
    title: "Home",
    meta: [],
    canonicalUrl: null,
};

function sessionWhoseCloseFails(changes: Partial<Session> = {}): FakeSession {
    return fakeSession({
        page: () => Promise.resolve(success(THE_HOME_PAGE)),
        close: () => Promise.resolve({ ...closedSession(), closeFailure: WHY_THE_CLOSE_FAILED }),
        ...changes,
    });
}

async function crawlOn(session: Session): ReturnType<typeof crawlInBrowser> {
    const trusted = await trustedProjectWith(MATRIX);
    return crawlInBrowser(fakeDriverOpening(session), {
        project: projectWith(MATRIX),
        target: targetOf(trusted, "chromium-desktop"),
        options: OPTIONS,
        redactor: fakeRedactor(),
        secrets: fakeSecretStore(),
        audit: fakeEventSink(),
    });
}

function assertCarriesTheCloseFailure(crawled: unknown): void {
    assert.ok(
        JSON.stringify(crawled).includes(WHY_THE_CLOSE_FAILED),
        `the close's failure was not carried along: ${JSON.stringify(crawled)}`,
    );
}

describe("Using the crawl in a browser", () => {
    describe("given a login plan cleared for the matrix's second target", () => {
        describe("when the crawl runs after that login", () => {
            test("then it should open one session, for the login's target, and crawl it once the login passes", async () => {
                const trusted = await trustedProjectWith(MATRIX);
                const tablet: Target = targetOf(trusted, "chromium-tablet");
                const login = clearRun(
                    parsedPlan(projectWith(MATRIX), LOGIN_PLAN),
                    trusted,
                    tablet.id,
                );
                const session = fakeSession({
                    page: () =>
                        Promise.resolve(
                            success({
                                url: `${ORIGIN}/`,
                                title: "Home",
                                meta: [],
                                canonicalUrl: null,
                            }),
                        ),
                });
                const browser = fakeDriverOpening(session);
                const crawled = await crawlInBrowser(browser, {
                    login,
                    runLogin: buildAdapters.loginRunner,
                    options: OPTIONS,
                    redactor: fakeRedactor(),
                    secrets: fakeSecretStore(),
                    audit: fakeEventSink(),
                });
                assert.ok(crawled.ok, JSON.stringify(crawled));
                assert.deepEqual(
                    browser.calls.to("open").map((call) => call.arguments[0]),
                    [tablet],
                );
                // The login's one navigation, then the crawl's, in the one session.
                assert.equal(session.calls.count("navigate"), 2);
                assert.equal(session.calls.count("close"), 1);
            });
        });
    });

    describe("given a session whose close reports a failure", () => {
        describe("when the crawl finishes", () => {
            test("then it should keep the page map and carry the close's failure along", async () => {
                const session = sessionWhoseCloseFails();
                const crawled = await crawlOn(session);
                assert.ok(crawled.ok, JSON.stringify(crawled));
                assert.equal(crawled.value.pages.length, 1);
                assertCarriesTheCloseFailure(crawled);
                assert.equal(session.calls.count("close"), 1);
            });
        });

        describe("when the crawl stops for its own reason", () => {
            test("then it should keep that reason and carry the close's failure along", async () => {
                const session = sessionWhoseCloseFails({
                    navigate: () =>
                        Promise.resolve(
                            failure({
                                code: DriverErrorCode.NavigationFailed,
                                detail: "the site is down",
                            }),
                        ),
                });
                const crawled = await crawlOn(session);
                assert.ok(!crawled.ok, JSON.stringify(crawled));
                assert.equal(crawled.error, "explore-start-unreachable");
                assertCarriesTheCloseFailure(crawled);
                assert.equal(session.calls.count("close"), 1);
            });
        });

        describe("when the crawl throws", () => {
            test("then it should reject with its own throw and carry the close's failure along", async () => {
                const session = sessionWhoseCloseFails({
                    page: () => Promise.reject(new Error(WHY_THE_CRAWL_THREW)),
                });
                await assert.rejects(crawlOn(session), (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.ok(error.message.includes(WHY_THE_CRAWL_THREW), error.message);
                    assert.ok(error.message.includes(WHY_THE_CLOSE_FAILED), error.message);
                    return true;
                });
                assert.equal(session.calls.count("close"), 1);
            });
        });
    });

    describe("given a session that closes", () => {
        describe("when the crawl throws", () => {
            test("then it should reject with its own throw alone", async () => {
                const session = fakeSession({
                    page: () => Promise.reject(new Error(WHY_THE_CRAWL_THREW)),
                });
                await assert.rejects(crawlOn(session), new Error(WHY_THE_CRAWL_THREW));
                assert.equal(session.calls.count("close"), 1);
            });
        });
    });
});
