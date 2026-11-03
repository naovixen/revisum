// Every request a page makes waits for the driver's decision. When the browser refuses that decision
// the request stays held, so what the page was doing never finishes: the run must say why, and not
// leave a later timeout to stand for something else that happened.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { OwnBrowserDriver } from "@revisum/driver-cdp";
import type {
    ActionGuard,
    ActionStep,
    DriverError,
    Result,
    SessionEnvironment,
    Target,
} from "@revisum/engine";
import { ADAPTER_OF_TARGET, BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, navigate, role, testId, visible } from "#test-support/browser/RawPlan.ts";
import { startRelayedDriver, type RelayedDriver } from "#test-support/browser/RelayedDriver.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { driverWith, sessionWith } from "#test-support/browser/WrappingSessions.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import {
    FIXTURE_FOLDER,
    networkHarness,
    startStub,
    type NetworkHarness,
} from "./network-stubs-support.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 2000;
const WHY_THE_BROWSER_REFUSED = "Invalid parameters: this decision was refused";
const SCRIPT_THE_PAGE_WAITS_FOR = "/script-the-page-waits-for.js";
const PAGE_THAT_WAITS_FOR_A_SCRIPT = "/waits-for-a-script.html";
const PAGE_NEVER_REACHED = "/never-reached.html";
const PAGE_THAT_GIVES_UP_ON_DATA = "/gives-up-on-data.html";
const DATA_GIVEN_UP_ON = "/data-given-up-on.json";

const html: (body: string) => FixtureRoute = (body) => () => ({
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>${body}</body></html>`,
});

const ROUTES = new Map<string, FixtureRoute>([
    [PAGE_THAT_WAITS_FOR_A_SCRIPT, html(`<script src="${SCRIPT_THE_PAGE_WAITS_FOR}"></script>`)],
    [PAGE_NEVER_REACHED, html("<p>Reached</p>")],
    [
        PAGE_THAT_GIVES_UP_ON_DATA,
        html(`<script>fetch("${DATA_GIVEN_UP_ON}").catch(() => undefined);</script>`),
    ],
    [
        SCRIPT_THE_PAGE_WAITS_FOR,
        () => ({
            headers: { "content-type": "text/javascript; charset=utf-8" },
            body: "document.title = 'Loaded';",
        }),
    ],
]);

// A run's step keeps only a failure's code, so what the driver said is read as it says it.
const notingActions = (
    driver: OwnBrowserDriver,
    actions: Result<void, DriverError>[],
): OwnBrowserDriver =>
    driverWith(driver, {
        open: async (target: Target, environment: SessionEnvironment) => {
            const opened = await driver.open(target, environment);
            if (!opened.ok) {
                return opened;
            }
            const session = opened.value;
            const act = async (
                step: ActionStep,
                guard: ActionGuard,
            ): Promise<Result<void, DriverError>> => {
                const acted = await session.act(step, guard);
                actions.push(acted);
                return acted;
            };
            return { ok: true as const, value: sessionWith(session, { act }) };
        },
    });

describe("Using the real browser driver", () => {
    describe("given the browser refuses to let a request go on", () => {
        let harness: CapabilityHarness;
        let relayed: RelayedDriver;

        before(async () => {
            harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
        });
        after(async () => {
            await harness.close();
        });
        beforeEach(async () => {
            relayed = await startRelayedDriver();
        });

        const navigateRefusing = async (
            page: string,
            refusedPath: string,
        ): Promise<Result<void, DriverError>> => {
            relayed.relay.tamperWith({
                method: "Fetch.continueRequest",
                applies: ({ pausedUrl }) => pausedUrl?.endsWith(refusedPath) ?? false,
                change: { refusal: WHY_THE_BROWSER_REFUSED },
            });
            const opened = await relayed.driver.open(harness.target(TARGET), harness.environment());
            assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
            try {
                return await opened.value.navigate(harness.url(page));
            } finally {
                await opened.value.close();
                await relayed.relay.close();
            }
        };

        describe("and the request is for a script the page's load waits for", () => {
            describe("when a plan navigates to the page", () => {
                test("then it should fail the navigation, saying why the browser refused", async () => {
                    const navigated = await navigateRefusing(
                        PAGE_THAT_WAITS_FOR_A_SCRIPT,
                        SCRIPT_THE_PAGE_WAITS_FOR,
                    );
                    assert.ok(!navigated.ok, "the navigation fails");
                    assert.match(navigated.error.detail, /this decision was refused/);
                });
            });
        });

        describe("and the request is for the document itself", () => {
            describe("when a plan navigates to it", () => {
                test("then it should fail the navigation, saying why the browser refused", async () => {
                    const navigated = await navigateRefusing(
                        PAGE_NEVER_REACHED,
                        PAGE_NEVER_REACHED,
                    );
                    assert.ok(!navigated.ok, "the navigation fails");
                    assert.match(navigated.error.detail, /this decision was refused/);
                });
            });
        });
    });

    describe("given the browser refuses a stub's answer", () => {
        let harness: NetworkHarness;

        before(async () => {
            harness = await networkHarness();
        });
        after(async () => {
            await harness.close();
        });

        describe("when a plan clicks what asks for the stubbed data, and clicks again", () => {
            test("then it should fail a click, saying why the browser refused", async () => {
                const relayed = await startRelayedDriver(FIXTURE_FOLDER);
                relayed.relay.tamperWith({
                    method: "Fetch.fulfillRequest",
                    change: { refusal: WHY_THE_BROWSER_REFUSED },
                });
                const actions: Result<void, DriverError>[] = [];
                const loadNotes = click(role("button", "Load notes"));
                try {
                    const ran = await harness.runSteps(
                        TARGET,
                        [
                            navigate("/resources.html"),
                            startStub("markupNotes"),
                            loadNotes,
                            loadNotes,
                            visible(testId("notes-kind"), "stubs.answer-shown"),
                        ],
                        {
                            drivers: new Map([
                                [ADAPTER_OF_TARGET[TARGET], notingActions(relayed.driver, actions)],
                            ]),
                        },
                    );
                    assert.ok(relayed.relay.timesTampered() > 0, "the answer was refused");
                    assert.notEqual(ran.result.state, "Passed");
                    const details = actions.flatMap((acted) =>
                        acted.ok ? [] : [acted.error.detail],
                    );
                    assert.match(details.join(), /this decision was refused/);
                } finally {
                    await relayed.relay.close();
                }
            });
        });
    });

    // The browser answers this way when a page gave up on a request before the decision arrived, as
    // an aborted fetch does. Nothing is held then, so nothing has gone wrong.
    describe("given the browser says a request is no longer held", () => {
        describe("when a plan navigates to a page that gave up on it", () => {
            test("then it should pass the navigation", async () => {
                const harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
                const relayed = await startRelayedDriver();
                relayed.relay.tamperWith({
                    method: "Fetch.continueRequest",
                    applies: ({ pausedUrl }) => pausedUrl?.endsWith(DATA_GIVEN_UP_ON) ?? false,
                    change: { refusal: "Invalid InterceptionId." },
                });
                const opened = await relayed.driver.open(
                    harness.target(TARGET),
                    harness.environment(),
                );
                assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
                try {
                    const navigated = await opened.value.navigate(
                        harness.url(PAGE_THAT_GIVES_UP_ON_DATA),
                    );
                    assert.equal(relayed.relay.timesTampered(), 1);
                    assert.deepEqual(navigated, { ok: true, value: undefined });
                } finally {
                    await opened.value.close();
                    await relayed.relay.close();
                    await harness.close();
                }
            });
        });
    });
});
