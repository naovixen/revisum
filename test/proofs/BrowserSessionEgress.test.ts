// Each browser session opens its own egress and goes through it, in a real headless browser. A proxy
// the browser silently ignores would send everything direct, so every proof here has a witness: the
// recording proxy of the session in question, or the run's own blocked origins. Nothing here needs the
// network: the example names are refused by the driver's allow-list or answered by a recording proxy.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { launchSharedBrowser, type OwnBrowserDriver } from "@revisum/driver-cdp";
import {
    defaultRedactor,
    type LoggedEvent,
    type SessionEnvironment,
    type Target,
} from "@revisum/engine";
import {
    startBrowserHarness,
    type BrowserHarness,
    type BrowserRun,
} from "#test-support/browser/BrowserHarness.ts";
import {
    ADAPTER_OF_TARGET,
    BrowserTarget,
    englishMatrix,
} from "#test-support/browser/BrowserTarget.ts";
import { navigate, testId, textEquals } from "#test-support/browser/RawPlan.ts";
import {
    realEgressSource,
    type EgressSourceForTest,
    type SessionEgressForTest,
} from "#test-support/browser/SessionEgressForTest.ts";
import { BROWSERS } from "#test-support/browsers.ts";
import { FIXED_TIME_MILLISECONDS, SEED, capabilityPlan } from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import { FIXTURES } from "#test-support/repository.ts";
import { ATTEMPT_SETTLED, ATTEMPT_STATE, attemptPage } from "./EgressChannels.ts";
import { driverWithEgress, hostBrowserDrivers } from "./HostBrowserDrivers.ts";
import { startRecordingProxy, type RecordingProxy } from "./StartRecordingProxy.ts";

const TARGET = BrowserTarget.Chrome;
const ADAPTER = ADAPTER_OF_TARGET[TARGET];
const LOCALE = "en-GB";
const PAGE_HOST = "127.0.0.1";
const STEP_TIMEOUT_MILLISECONDS = 10_000;

const FIRST_SESSION_HOST = "first-session.example";
const SECOND_SESSION_HOST = "second-session.example";
const FIRST_SESSION_PATH = "/first-session.html";
const SECOND_SESSION_PATH = "/second-session.html";
const QUIET_PATH = "/quiet.html";
const REFUSED_IMAGES_PATH = "/refused-images.html";
const SECURE_REFUSED_HOST = "refused.example";
const PLAIN_REFUSED_HOST = "plain-refused.example";

const htmlRoute =
    (attempt: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: attemptPage(attempt),
    });

const fetching = (host: string): string =>
    `<script>fetch(${JSON.stringify(`https://${host}/`)}, { mode: "no-cors" });</script>`;

const stepsOnPage = (path: string): readonly unknown[] => [
    navigate(path),
    textEquals(testId(ATTEMPT_STATE), ATTEMPT_SETTLED, "session-egress.attempt-settled"),
];

let harness: BrowserHarness;
let deadOrigin: string;
let localhostOrigin: string;
let localhostSubdomainOrigin: string;

// A port nobody is listening on now.
async function deadPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, PAGE_HOST, resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

before(async () => {
    deadOrigin = `http://${PAGE_HOST}:${await deadPort()}`;
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "capability-app"),
        routes: new Map<string, FixtureRoute>([
            [QUIET_PATH, htmlRoute("")],
            [FIRST_SESSION_PATH, htmlRoute(fetching(FIRST_SESSION_HOST))],
            [SECOND_SESSION_PATH, htmlRoute(fetching(SECOND_SESSION_HOST))],
            [
                REFUSED_IMAGES_PATH,
                htmlRoute(
                    `<img alt="" src="https://${SECURE_REFUSED_HOST}/picture.png"><img alt="" src="http://${PLAIN_REFUSED_HOST}/picture.png">`,
                ),
            ],
        ]),
        projectFile: (origin) => {
            const { port } = new URL(origin);
            localhostOrigin = `http://localhost:${port}`;
            localhostSubdomainOrigin = `http://app.localhost:${port}`;
            return {
                origins: [
                    origin,
                    deadOrigin,
                    localhostOrigin,
                    localhostSubdomainOrigin,
                    `https://${FIRST_SESSION_HOST}`,
                    `https://${SECOND_SESSION_HOST}`,
                ],
                limits: { stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS, maximumSteps: 20 },
                matrix: englishMatrix(Object.values(BrowserTarget)),
            };
        },
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        drivers: hostBrowserDrivers([TARGET]),
        planFor: capabilityPlan,
    });
});
after(async () => {
    await harness.close();
});

const sessionEnvironment = (): SessionEnvironment => ({
    baseUrl: harness.origin,
    allowedOrigins: harness.project.origins,
    seed: SEED,
    fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
    sensitiveSelectors: defaultRedactor().selectors,
    timeoutMilliseconds: 5_000,
});

const connectionFailuresLogged = (ran: BrowserRun): readonly LoggedEvent[] =>
    ran.events.read().filter((event) => String(event.kind) === "session.connection-failed");

// A browser may try a refused tunnel more than once.
const distinct = (hosts: readonly string[]): readonly string[] => [...new Set(hosts)];

const driverOn = (egress: EgressSourceForTest): OwnBrowserDriver =>
    driverWithEgress({ executablePath: BROWSERS.chrome, egress });

const runWith = (driver: OwnBrowserDriver, path: string): Promise<BrowserRun> =>
    harness.runSteps(TARGET, stepsOnPage(path), { drivers: new Map([[ADAPTER, driver]]) });

// Counts what a session does to its egress.
function watchedSource(delegate: EgressSourceForTest) {
    const askedFor: (readonly string[])[] = [];
    let closes = 0;
    const source: EgressSourceForTest = async (allowedOrigins) => {
        askedFor.push(allowedOrigins);
        const egress = await delegate(allowedOrigins);
        return {
            ...egress,
            close: () => {
                closes += 1;
                return egress.close();
            },
        };
    };
    return { source, askedFor, closes: () => closes };
}

const egressOn = (
    proxy: RecordingProxy,
    refusedOrigins: readonly string[] = [],
): EgressSourceForTest => {
    const egress: SessionEgressForTest = {
        proxy: { server: proxy.server, includeLoopback: true },
        refusedOrigins: () => refusedOrigins,
        connectionFailures: () => [],
        close: () => Promise.resolve(),
    };
    return () => Promise.resolve(egress);
};

async function openOutcome(driver: OwnBrowserDriver, target: Target = harness.target(TARGET)) {
    const opened = await driver.open(target, sessionEnvironment());
    if (opened.ok) {
        await opened.value.close();
    }
    return opened;
}

describe("Using the driver's session egress", () => {
    describe("given an egress source that answers with an empty proxy value", () => {
        describe("when a session opens", () => {
            test("then it should refuse to open, since a context with no proxy goes direct", async () => {
                const emptyProxy: EgressSourceForTest = () =>
                    Promise.resolve({
                        proxy: { server: "", includeLoopback: true },
                        refusedOrigins: () => [],
                        connectionFailures: () => [],
                        close: () => Promise.resolve(),
                    });
                const opened = await openOutcome(driverOn(emptyProxy));
                assert.ok(!opened.ok, "the session opened with an empty proxy value");
                assert.equal(opened.error.reason, "launch-failed");
            });
        });
    });

    describe("given an egress source whose proxy starts", () => {
        describe("when a session opens", () => {
            test("then it should open, so the refusal of an empty value means something", async () => {
                const opened = await openOutcome(driverOn(realEgressSource));
                assert.ok(opened.ok, JSON.stringify(opened));
            });
        });

        describe("when a session opens and closes", () => {
            test("then it should ask for an egress once, with the session's allowed origins", async () => {
                const watched = watchedSource(realEgressSource);
                await openOutcome(driverOn(watched.source));
                assert.deepEqual(watched.askedFor, [harness.project.origins]);
            });

            test("then it should close the egress once", async () => {
                const watched = watchedSource(realEgressSource);
                await openOutcome(driverOn(watched.source));
                assert.equal(watched.closes(), 1);
            });
        });
    });

    describe("given an egress source that fails to start", () => {
        describe("when a session opens", () => {
            test("then it should refuse to open, saying why", async () => {
                const failing: EgressSourceForTest = () =>
                    Promise.reject(new Error("no port for the proxy"));
                const opened = await openOutcome(driverOn(failing));
                assert.ok(!opened.ok, "the session opened with no egress");
                assert.equal(opened.error.reason, "launch-failed");
                assert.match(opened.error.detail, /no port for the proxy/);
            });
        });
    });

    describe("given a target on an engine the driver does not drive", () => {
        describe("when a session opens", () => {
            test("then it should refuse before starting any egress", async () => {
                const watched = watchedSource(realEgressSource);
                const target: Target = { ...harness.target(TARGET), engine: "firefox" };
                const opened = await openOutcome(driverOn(watched.source), target);
                assert.ok(!opened.ok, "the session opened on another engine");
                assert.equal(opened.error.reason, "engine-not-supported");
                assert.deepEqual(watched.askedFor, []);
            });
        });
    });

    describe("given two sessions one after the other in one browser, each with its own proxy", () => {
        let firstProxy: RecordingProxy;
        let secondProxy: RecordingProxy;
        before(async () => {
            firstProxy = await startRecordingProxy({ relayedHost: PAGE_HOST });
            secondProxy = await startRecordingProxy({ relayedHost: PAGE_HOST });
            const browser = await launchSharedBrowser({
                executablePath: BROWSERS.chrome,
                locale: LOCALE,
            });
            try {
                const onBrowser = (proxy: RecordingProxy): OwnBrowserDriver =>
                    driverWithEgress({
                        executablePath: BROWSERS.chrome,
                        browserSource: () => Promise.resolve(browser),
                        egress: egressOn(proxy),
                    });
                await runWith(onBrowser(firstProxy), FIRST_SESSION_PATH);
                await runWith(onBrowser(secondProxy), SECOND_SESSION_PATH);
            } finally {
                await browser.stop();
            }
        });
        after(async () => {
            await firstProxy.close();
            await secondProxy.close();
        });

        describe("when each fetches a declared address of its own", () => {
            test("then it should send the first session's traffic only to its proxy", () => {
                assert.deepEqual(distinct(firstProxy.tunnelledHosts()), [FIRST_SESSION_HOST]);
            });

            test("then it should send the second session's traffic only to its proxy", () => {
                assert.deepEqual(distinct(secondProxy.tunnelledHosts()), [SECOND_SESSION_HOST]);
            });
        });
    });

    describe("given a session whose proxy refused origins the driver's allow-list also refused", () => {
        describe("when the run reads its blocked origins", () => {
            test("then it should hold each origin once, in the browser's form, and keep a different port apart", async () => {
                const proxy = await startRecordingProxy({ relayedHost: PAGE_HOST });
                try {
                    const ran = await runWith(
                        driverOn(
                            egressOn(proxy, [
                                `${SECURE_REFUSED_HOST}:443`,
                                `${PLAIN_REFUSED_HOST}:80`,
                                `${SECURE_REFUSED_HOST}:8443`,
                                "only-the-proxy-saw.example:443",
                            ]),
                        ),
                        REFUSED_IMAGES_PATH,
                    );
                    assert.deepEqual(ran.result.blockedOrigins, [
                        `http://${PLAIN_REFUSED_HOST}`,
                        `https://${SECURE_REFUSED_HOST}`,
                        "only-the-proxy-saw.example:443",
                        `${SECURE_REFUSED_HOST}:8443`,
                    ]);
                } finally {
                    await proxy.close();
                }
            });
        });
    });

    describe("given a host run and a declared origin nobody listens on", () => {
        describe("when a plan navigates to it", () => {
            test("then it should fail with navigation-failed rather than render an answer", async () => {
                const ran = await harness.runSteps(TARGET, stepsOnPage(`${deadOrigin}/`));
                assert.equal(ran.result.steps[0]?.code, "navigation-failed");
                assert.deepEqual(ran.result.blockedOrigins, []);
            });

            test("then it should log that nothing answered there", async () => {
                const ran = await harness.runSteps(TARGET, stepsOnPage(`${deadOrigin}/`));
                const failures = connectionFailuresLogged(ran);
                assert.equal(failures.length, 1, JSON.stringify(ran.events.read()));
                assert.match(failures[0]?.detail ?? "", /Nothing answered/);
                assert.match(
                    failures[0]?.origin ?? "",
                    new RegExp(PAGE_HOST.replaceAll(".", "\\.")),
                );
            });
        });

        describe("when a plan navigates to an origin that answers", () => {
            test("then it should pass, so the failure means something", async () => {
                const ran = await harness.runSteps(TARGET, stepsOnPage(QUIET_PATH));
                assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result));
            });

            test("then it should log no connection failure", async () => {
                const ran = await harness.runSteps(TARGET, stepsOnPage(QUIET_PATH));
                assert.deepEqual(connectionFailuresLogged(ran), []);
            });
        });
    });

    describe("given a host run and an app bound only to 127.0.0.1", () => {
        describe("when a plan navigates to it as a declared localhost", () => {
            test("then it should load the page", async () => {
                const ran = await harness.runSteps(
                    TARGET,
                    stepsOnPage(`${localhostOrigin}${QUIET_PATH}`),
                );
                assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result));
            });
        });

        describe("when a plan navigates to it as a declared name under localhost", () => {
            test("then it should load the page", async () => {
                const ran = await harness.runSteps(
                    TARGET,
                    stepsOnPage(`${localhostSubdomainOrigin}${QUIET_PATH}`),
                );
                assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result));
            });
        });
    });
});
