// What a browser the driver launched asks for on its own, with no page asking. The driver's public
// way to route a browser is the only one used here, so these are its real launch flags. The browser
// is pointed at a proxy on loopback that answers everything itself, which is what makes it safe to
// let the browser try: it can ask for any address, and nothing leaves the machine.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/CreateBrowserDriver.ts";
import { navigate, testId, textEquals } from "#test-support/browser/RawPlan.ts";
import { FIXED_TIME_MILLISECONDS, SEED, capabilityPlan } from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import { FIXTURES } from "#test-support/repository.ts";
import { onTarget } from "#test-support/TestTier.ts";
import { ATTEMPT_SETTLED, ATTEMPT_STATE, attemptPage } from "./EgressChannels.ts";
import { startRecordingProxy, type RecordingProxy } from "./StartRecordingProxy.ts";

const BACKGROUND_HOSTS = [
    "accounts.google.com",
    "update.googleapis.com",
    "clients2.google.com",
    "www.google.com",
];

// Reserved for examples, and answered by the recording proxy. It has to be declared, or the driver's
// allow-list would refuse the request before the proxy saw it.
const DECLARED_HOST = "declared-address.example";
const DECLARED_ORIGIN = `https://${DECLARED_HOST}`;

const QUIET_PATH = "/quiet.html";
const FETCHING_PATH = "/fetching.html";

const htmlRoute =
    (attempt: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: attemptPage(attempt),
    });

const stepsOnPage = (path: string): readonly unknown[] => [
    navigate(path),
    textEquals(testId(ATTEMPT_STATE), ATTEMPT_SETTLED, "background.attempt-settled"),
];

let proxy: RecordingProxy;
let harness: BrowserHarness;

before(async () => {
    proxy = await startRecordingProxy();
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "capability-app"),
        routes: new Map<string, FixtureRoute>([
            [QUIET_PATH, htmlRoute("")],
            [
                FETCHING_PATH,
                htmlRoute(
                    `<script>fetch(${JSON.stringify(`${DECLARED_ORIGIN}/`)}, { mode: "no-cors" });</script>`,
                ),
            ],
        ]),
        projectFile: (origin) => ({
            origins: [origin, DECLARED_ORIGIN],
            limits: { stepTimeoutMilliseconds: 10_000, maximumSteps: 20 },
            matrix: englishMatrix(Object.values(BrowserTarget)),
        }),
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        drivers: driversForTargets(Object.values(BrowserTarget), {
            // The page's own origin is on loopback, which goes direct; everything else reaches the proxy.
            proxy: { server: proxy.server, includeLoopback: false },
        }),
        planFor: capabilityPlan,
    });
});
after(async () => {
    await harness.close();
    await proxy.close();
});

async function runPage(targetId: BrowserTarget, path: string): Promise<void> {
    proxy.forgetAskedHosts();
    const ran = await harness.runSteps(targetId, stepsOnPage(path));
    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result));
}

describe("Using a browser the driver launched", () => {
    for (const targetId of Object.values(BrowserTarget)) {
        describe(`given a run on ${targetId}`, onTarget(targetId), () => {
            describe("and a page that asks for nothing outside its own origin", () => {
                describe("when the run opens it and waits for it to settle", () => {
                    let asked: readonly string[];
                    before(async () => {
                        await runPage(targetId, QUIET_PATH);
                        asked = proxy.askedHosts();
                    });

                    for (const host of BACKGROUND_HOSTS) {
                        test(`then it should attempt no connection to ${host}`, () => {
                            assert.ok(!asked.includes(host), `asked: ${JSON.stringify(asked)}`);
                        });
                    }

                    test("then it should attempt no connection to any other address", () => {
                        const others = asked.filter((host) => !BACKGROUND_HOSTS.includes(host));
                        assert.deepEqual(others, []);
                    });
                });
            });

            describe("and a page that fetches a declared address on another site", () => {
                describe("when the run opens it", () => {
                    test("then it should go on to a TLS handshake there, so the proxy's silence means something", async () => {
                        await runPage(targetId, FETCHING_PATH);
                        assert.ok(
                            proxy.tunnelledHosts().includes(DECLARED_HOST),
                            `tunnelled: ${JSON.stringify(proxy.tunnelledHosts())}`,
                        );
                    });
                });
            });
        });
    }
});
