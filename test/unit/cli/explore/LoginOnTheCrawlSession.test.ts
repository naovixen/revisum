// A login signs in to one session, and the crawl reads that same one. So the two travel as one value,
// made only where the crawl opens the session, and a login runs on the session in that value.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildAdapters, crawlInBrowser, type LoginRunner } from "@revisum/cli";
import { success, type ExploreOptions, type Session } from "@revisum/engine";
import { clearRun } from "#test-support/builders/ClearRun.ts";
import { fakeDriverOpening } from "#test-support/fakes/session/FakeDriver.ts";
import { fakeEventSink } from "#test-support/fakes/ports/FakeEventSink.ts";
import { fakeRedactor } from "#test-support/fakes/ports/FakeRedactor.ts";
import { fakeSecretStore } from "#test-support/fakes/ports/FakeSecretStore.ts";
import { fakeSession, type FakeSession } from "#test-support/fakes/session/FakeSession.ts";
import { ORIGIN } from "../../engine/plan/examples/GoldenPlan.ts";
import { parsedPlan } from "../../engine/secrets/examples/SecretRun.ts";
import {
    projectWith,
    targetInput,
    targetOf,
    trustedProjectWith,
} from "../../engine/target/examples/TargetOf.ts";
import { GuaranteeLevel } from "@revisum/contracts";

const MATRIX = [targetInput("chromium-desktop", "fake-any", "chromium", "desktop-1280")];

const OPTIONS: ExploreOptions = {
    start: `${ORIGIN}/`,
    maximumPages: 1,
    maximumDepth: 0,
    pageTimeoutMilliseconds: 1000,
    placement: GuaranteeLevel.Host,
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

type Given<Member extends keyof Session> = Session[Member] extends (
    ...given: infer Taken
) => unknown
    ? Taken
    : never;

// A session as a class may well write one: its state is private to the instance, so a method called
// on anything but the instance itself cannot reach it.
class SessionKeepingItsStatePrivate implements Session {
    readonly #session: FakeSession;
    readonly browser: Session["browser"];
    readonly network: Session["network"];
    readonly storage: Session["storage"];
    readonly clock: Session["clock"];
    readonly clipboard: Session["clipboard"];

    constructor(session: FakeSession) {
        this.#session = session;
        this.browser = session.browser;
        this.network = session.network;
        this.storage = session.storage;
        this.clock = session.clock;
        this.clipboard = session.clipboard;
    }

    navigate(...given: Given<"navigate">) {
        return this.#session.navigate(...given);
    }
    page() {
        return this.#session.page();
    }
    act(...given: Given<"act">) {
        return this.#session.act(...given);
    }
    probe(...given: Given<"probe">) {
        return this.#session.probe(...given);
    }
    screenshot(...given: Given<"screenshot">) {
        return this.#session.screenshot(...given);
    }
    screenshotHidingFields(...given: Given<"screenshotHidingFields">) {
        return this.#session.screenshotHidingFields(...given);
    }
    audit() {
        return this.#session.audit();
    }
    accessibilitySnapshot() {
        return this.#session.accessibilitySnapshot();
    }
    frame(...given: Given<"frame">) {
        return this.#session.frame(...given);
    }
    crashed() {
        return this.#session.crashed();
    }
    unsupportedOpenings() {
        return this.#session.unsupportedOpenings();
    }
    download(...given: Given<"download">) {
        return this.#session.download(...given);
    }
    runScript(...given: Given<"runScript">) {
        return this.#session.runScript(...given);
    }
    linkTargets() {
        return this.#session.linkTargets();
    }
    isRequestHeld() {
        return this.#session.isRequestHeld();
    }
    recordsSoFar() {
        return this.#session.recordsSoFar();
    }
    close() {
        return this.#session.close();
    }
    newTab(...given: Given<"newTab">) {
        return this.#session.newTab(...given);
    }
}

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

        describe("and a session written as a class with private state", () => {
            describe("when the crawl runs after it", () => {
                test("then it should run the login's steps on that session", async () => {
                    const trusted = await trustedProjectWith(MATRIX);
                    const target = targetOf(trusted, "chromium-desktop");
                    const login = clearRun(
                        parsedPlan(projectWith(MATRIX), LOGIN_PLAN),
                        trusted,
                        target.id,
                    );
                    const inner = fakeSession({
                        page: () => Promise.resolve(success(THE_HOME_PAGE)),
                    });

                    const crawled = await crawlInBrowser(
                        fakeDriverOpening(new SessionKeepingItsStatePrivate(inner)),
                        {
                            login,
                            runLogin: buildAdapters.loginRunner,
                            options: OPTIONS,
                            redactor: fakeRedactor(),
                            secrets: fakeSecretStore(),
                            audit: fakeEventSink(),
                        },
                    );

                    assert.ok(crawled.ok, JSON.stringify(crawled));
                    // The login's one navigation, then the crawl's.
                    assert.equal(inner.calls.count("navigate"), 2);
                });
            });
        });
    });
});
