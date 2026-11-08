// A login signs in to one session, and the crawl reads that same one. So the two travel as one value,
// made only where the crawl opens the session, and a login runs on the session in that value.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildAdapters, crawlInBrowser, type LoginRunner } from "@revisum/cli";
import { success, type ExploreOptions } from "@revisum/engine";
import { clearRun } from "#test-support/policy-clearance.ts";
import { fakeDriverOpening } from "#test-support/fakes/FakeDriver.ts";
import { fakeEventSink } from "#test-support/fakes/FakeEventSink.ts";
import { fakeRedactor } from "#test-support/fakes/FakeRedactor.ts";
import { fakeSecretStore } from "#test-support/fakes/FakeSecretStore.ts";
import { fakeSession } from "#test-support/fakes/FakeSession.ts";
import { ORIGIN } from "../engine/plan-examples.ts";
import { parsedPlan } from "../engine/secret-examples.ts";
import {
    projectWith,
    targetInput,
    targetOf,
    trustedProjectWith,
} from "../engine/target-examples.ts";

const MATRIX = [targetInput("chromium-desktop", "fake-any", "chromium", "desktop-1280")];

const OPTIONS: ExploreOptions = {
    start: `${ORIGIN}/`,
    maximumPages: 1,
    maximumDepth: 0,
    pageTimeoutMilliseconds: 1000,
    placement: "host",
};

const LOGIN_PLAN = {
    version: "1.3",
    meta: { featureId: "LOGIN-1", specReference: "specs/login.md", title: "Sign in" },
    targets: ["chromium-desktop"],
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

const THE_HOME_PAGE = { url: `${ORIGIN}/`, title: "Home", meta: [], canonicalUrl: null };

describe("Using the crawl in a browser", () => {
    describe("given a cleared login", () => {
        describe("when the crawl runs after it", () => {
            test("then it should run the login on the one session it opened, as one value", async () => {
                const trusted = await trustedProjectWith(MATRIX);
                const target = targetOf(trusted, "chromium-desktop");
                const login = clearRun(
                    parsedPlan(projectWith(MATRIX), LOGIN_PLAN),
                    trusted,
                    target.id,
                );
                const session = fakeSession({
                    page: () => Promise.resolve(success(THE_HOME_PAGE)),
                });
                const seen: Parameters<LoginRunner>[0][] = [];
                const runLogin: LoginRunner = (onItsSession, inputs) => {
                    seen.push(onItsSession);
                    return buildAdapters.loginRunner(onItsSession, inputs);
                };
                const browser = fakeDriverOpening(session);

                const crawled = await crawlInBrowser(browser, {
                    login,
                    runLogin,
                    options: OPTIONS,
                    redactor: fakeRedactor(),
                    secrets: fakeSecretStore(),
                    audit: fakeEventSink(),
                });

                assert.ok(crawled.ok, JSON.stringify(crawled));
                assert.equal(seen.length, 1);
                const [onItsSession] = seen;
                assert.ok(onItsSession !== undefined);
                assert.equal(onItsSession.session, session);
                assert.equal(onItsSession.login, login);
                assert.equal(browser.calls.count("open"), 1);
                // The login's one navigation, then the crawl's, in the one session.
                assert.equal(session.calls.count("navigate"), 2);
            });
        });
    });
});
