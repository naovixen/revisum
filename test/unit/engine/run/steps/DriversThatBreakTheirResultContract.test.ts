// A driver's ports promise a Result. One that throws instead breaks that promise, but the run must still
// end with a stated outcome, so a run's result always exists and says why it could not test.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { failure, success } from "@revisum/contracts";
import { cdpDriver, type EgressSource } from "@revisum/driver-cdp";
import type { BrowserDriver } from "@revisum/engine";
import { fakeRunEventSink } from "#test-support/fakes/ports/FakeRunEventSink.ts";
import { fakeSessionOnOrders, runOnFakeSession, stepSummaries } from "../examples/RunOnFakeSession.ts";
import { OPEN_CART, unsafePlan } from "../../plan/unsafe-features/examples/UnsafePlan.ts";

const DRIVER_BROKE = "the driver broke";
const breaks = (): never => {
    throw new Error(DRIVER_BROKE);
};
const rejects = (): Promise<never> => Promise.reject(new Error(DRIVER_BROKE));

const BROKEN_MEMBERS = [
    { name: "supports throws", driver: { supports: breaks } },
    { name: "open throws", driver: { open: breaks } },
    { name: "open rejects", driver: { open: rejects } },
    { name: "build check throws", driver: { build: breaks } },
    { name: "build check rejects", driver: { build: rejects } },
];

// Neither of these sources gets as far as a browser, so none is launched.
const NO_BROWSER_IS_LAUNCHED = "no-browser-is-launched";

const BROKEN_EGRESS_SOURCES: readonly { readonly name: string; readonly source: EgressSource }[] = [
    { name: "rejects as it starts", source: rejects },
    {
        name: "names no proxy, and its egress rejects as it closes",
        source: () =>
            Promise.resolve(
                success({
                    proxy: { server: "direct://", includeLoopback: false },
                    refusedOrigins: () => success([]),
                    connectionFailures: () => [],
                    close: rejects,
                }),
            ),
    },
];

function realDriverOn(context: TestContext, source: EgressSource) {
    const egress = context.mock.fn(source);
    const driver = cdpDriver({ executablePath: NO_BROWSER_IS_LAUNCHED, egress });
    const open: BrowserDriver["open"] = (target, environment) => driver.open(target, environment);
    return { egress, open };
}

describe("Using the run", () => {
    for (const { name, driver } of BROKEN_MEMBERS) {
        describe(`given a driver whose ${name}`, () => {
            describe("when a plan is run", () => {
                test("then it should end Errored instead of rejecting, with nothing run", async () => {
                    const session = fakeSessionOnOrders();
                    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                        session,
                        driver,
                    });
                    assert.equal(result.state, "Errored", JSON.stringify(result));
                    assert.equal(JSON.stringify(result).includes(DRIVER_BROKE), false);
                    assert.deepEqual(stepSummaries(result).length <= 1, true);
                });
            });
        });
    }

    for (const { name, source } of BROKEN_EGRESS_SOURCES) {
        describe(`given the real driver and an egress source that ${name}`, () => {
            describe("when a plan is run", () => {
                test("then it should end Errored instead of rejecting, and only the log should say why", async (context) => {
                    const { egress, open } = realDriverOn(context, source);
                    const events = fakeRunEventSink();

                    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                        driver: { open },
                        events,
                    });

                    assert.equal(egress.mock.callCount(), 1);
                    assert.equal(result.state, "Errored", JSON.stringify(result));
                    assert.equal(JSON.stringify(result).includes(DRIVER_BROKE), false);
                    assert.ok(
                        events
                            .read()
                            .some((event) => event.detail?.includes(DRIVER_BROKE) === true),
                        JSON.stringify(events.read()),
                    );
                });
            });
        });
    }

    describe("given the real driver and an egress source that answers it could not start", () => {
        describe("when a plan is run", () => {
            test("then it should end TargetUnavailable, as the driver kept its promise", async (context) => {
                const { egress, open } = realDriverOn(context, () =>
                    Promise.resolve(failure("no port for the proxy")),
                );

                const { result } = await runOnFakeSession(unsafePlan([OPEN_CART]), {
                    driver: { open },
                });

                assert.equal(egress.mock.callCount(), 1);
                assert.equal(result.state, "TargetUnavailable", JSON.stringify(result));
            });
        });
    });

    describe("given a driver that keeps its promises", () => {
        describe("when a plan is run", () => {
            test("then it should pass", async () => {
                const { result } = await runOnFakeSession(unsafePlan([OPEN_CART]));
                assert.equal(result.state, "Passed", JSON.stringify(result));
            });
        });
    });
});
