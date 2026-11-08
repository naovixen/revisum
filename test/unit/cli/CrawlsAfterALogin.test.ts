// A crawl with a login plan runs on the login's own project and target: its session is opened for
// the target the login was cleared for, and the login runs in that same session, so what it signs
// in to is what the crawl reads.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { crawlInBrowser } from "@revisum/cli";
import { success, type ExploreOptions, type Target } from "@revisum/engine";
import { clearRun } from "#test-support/policy-clearance.ts";
import { fakeDriverOpening } from "#test-support/fakes/FakeDriver.ts";
import { fakeEventSink } from "#test-support/fakes/FakeEventSink.ts";
import { fakeRedactor } from "#test-support/fakes/FakeRedactor.ts";
import { fakeSecretStore } from "#test-support/fakes/FakeSecretStore.ts";
import { closedSession, fakeSession } from "#test-support/fakes/FakeSession.ts";
import { ORIGIN } from "../engine/plan-examples.ts";
import { parsedPlan } from "../engine/secret-examples.ts";
import {
    projectWith,
    targetInput,
    targetOf,
    trustedProjectWith,
} from "../engine/target-examples.ts";

const DESKTOP = targetInput("chromium-desktop", "fake-any", "chromium", "desktop-1280");
const TABLET = targetInput("chromium-tablet", "fake-any", "chromium", "tablet-820");
const MATRIX = [DESKTOP, TABLET];

const OPTIONS: ExploreOptions = {
    start: `${ORIGIN}/`,
    maximumPages: 1,
    maximumDepth: 0,
    pageTimeoutMilliseconds: 1000,
    placement: "host",
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
        describe("when the crawl has run", () => {
            test("then it should say so, in the crawl's outcome or its audit log", async () => {
                const whyTheCloseFailed = "the crawl's profile folder is still held";
                const trusted = await trustedProjectWith(MATRIX);
                const desktop: Target = targetOf(trusted, "chromium-desktop");
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
                    close: () =>
                        Promise.resolve({
                            ...closedSession(),
                            closeFailure: whyTheCloseFailed,
                        }),
                });
                const audit = fakeEventSink();
                const crawled = await crawlInBrowser(fakeDriverOpening(session), {
                    project: projectWith(MATRIX),
                    target: desktop,
                    options: OPTIONS,
                    redactor: fakeRedactor(),
                    secrets: fakeSecretStore(),
                    audit,
                });
                const isInTheOutcome = !crawled.ok;
                const isInTheLog = JSON.stringify(audit.recorded).includes(whyTheCloseFailed);
                assert.equal(
                    isInTheOutcome || isInTheLog,
                    true,
                    `the close's failure was reported nowhere: ${JSON.stringify(crawled)}`,
                );
            });
        });
    });
});
