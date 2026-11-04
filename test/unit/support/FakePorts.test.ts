import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    failure,
    planParser,
    run,
    success,
    type Origin,
    type RunPorts,
    type Session,
    type SessionEnvironment,
    type Target,
} from "@revisum/engine";
import {
    fakeDriver,
    fakeDriverNeverLaunching,
    fakeDriverOpening,
} from "#test-support/fakes/FakeDriver.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { FAKE_PAGE, fakeSession } from "#test-support/fakes/FakeSession.ts";
import { fakeStoragePort } from "#test-support/fakes/FakeStoragePort.ts";
import { leaveOut } from "#test-support/fakes/LeaveOut.ts";
import { authorise, trustedProjectFrom } from "#test-support/policy-clearance.ts";
import { testProject } from "../engine/plan-examples.ts";
import {
    DEFAULT_CLOCK_START,
    DEFAULT_SEED,
    OPEN_ORDERS,
    ORIGIN as RUN_ORIGIN,
    accepted,
    planOf,
    projectFileWith,
    projectWith,
} from "../engine/run-value-examples.ts";

const OPTIONAL_SESSION_MEMBERS: readonly (keyof Session)[] = [
    "screenshotHidingFields",
    "frame",
    "crashed",
    "isDialogOpen",
    "unsupportedOpenings",
    "download",
    "runScript",
    "linkTargets",
    "connectionFailures",
    "refusedRequestDecisions",
    "newTab",
    "network",
    "storage",
    "clock",
    "clipboard",
];

const firstOf = <Item>(items: readonly Item[]): Item => {
    const first = items[0];
    assert.ok(first !== undefined, "the test project declares one");
    return first;
};
const ORIGIN: Origin = firstOf(testProject().origins);
const TARGET: Target = firstOf(testProject().matrix);
const ENVIRONMENT: SessionEnvironment = {
    baseUrl: "https://app.example",
    allowedOrigins: [],
    seed: 7,
    fixedTimeMilliseconds: 0,
    sensitiveSelectors: [],
    timeoutMilliseconds: 1000,
};

describe("Using a fake port", () => {
    describe("given a fake session with nothing overridden", () => {
        describe("when a test asks what it offers", () => {
            test("then it should offer every optional member of the port", () => {
                const session = fakeSession();
                const missing = OPTIONAL_SESSION_MEMBERS.filter(
                    (member) => !Object.hasOwn(session, member),
                );
                assert.deepEqual(missing, []);
            });
        });

        describe("when a step reads the page", () => {
            test("then it should show the fake page and note the call", async () => {
                const session = fakeSession();
                assert.deepEqual(await session.page(), FAKE_PAGE);
                assert.deepEqual(session.calls.all(), [{ method: "page", arguments: [] }]);
            });
        });

        describe("when a new tab is opened", () => {
            test("then it should give the same session, so its calls are noted too", async () => {
                const session = fakeSession();
                const tab = await session.newTab?.("https://app.example/other");
                assert.ok(tab?.ok === true);
                await tab.value.page();
                assert.equal(session.calls.count("page"), 1);
                assert.deepEqual(session.calls.to("newTab"), [
                    { method: "newTab", arguments: ["https://app.example/other"] },
                ]);
            });
        });
    });

    describe("given a fake session with an override", () => {
        describe("when the overridden method is called", () => {
            test("then it should answer as the override says and note the call", async () => {
                const refused = failure({ code: "timeout" as const, detail: "slow" });
                const session = fakeSession({ navigate: () => Promise.resolve(refused) });
                assert.deepEqual(await session.navigate("https://app.example/"), refused);
                assert.equal(session.calls.count("navigate"), 1);
            });
        });
    });

    describe("given a fake session without a member named by the test", () => {
        describe("when a test asks what it offers", () => {
            test("then it should lack that member and keep the others", () => {
                const session = fakeSession({}, ["frame"]);
                assert.equal(Object.hasOwn(session, "frame"), false);
                assert.equal(Object.hasOwn(session, "newTab"), true);
            });
        });
    });

    describe("given a fake storage port", () => {
        describe("when an entry is written", () => {
            test("then it should read it back", async () => {
                const storage = fakeStoragePort();
                await storage.write("local", ORIGIN, "key", "value");
                assert.deepEqual(await storage.read("local", ORIGIN, "key"), success("value"));
            });
        });

        describe("when an entry is written and removed", () => {
            test("then it should read nothing", async () => {
                const storage = fakeStoragePort();
                await storage.write("local", ORIGIN, "key", "value");
                await storage.remove("local", ORIGIN, "key");
                assert.deepEqual(await storage.read("local", ORIGIN, "key"), success(null));
            });
        });
    });

    describe("given a fake driver opening a given session", () => {
        describe("when it opens", () => {
            test("then it should give that session and note the call", async () => {
                const session = fakeSession();
                const driver = fakeDriverOpening(session);
                const opened = await driver.open(TARGET, ENVIRONMENT);
                assert.ok(opened.ok);
                assert.equal(opened.value, session);
                assert.equal(driver.calls.count("open"), 1);
            });
        });
    });

    describe("given a fake driver that never launches", () => {
        describe("when it opens", () => {
            test("then it should report launch-failed", async () => {
                const opened = await fakeDriverNeverLaunching().open(TARGET, ENVIRONMENT);
                assert.ok(!opened.ok);
                assert.equal(opened.error.reason, "launch-failed");
            });
        });
    });

    describe("given the whole set of fake ports", () => {
        describe("when a plan runs on them with nothing overridden", () => {
            test("then it should pass and show what reached the driver", async () => {
                const project = projectWith();
                const driver = fakeDriver();
                const result = await run(
                    {
                        plan: authorise(
                            accepted(planParser(project), planOf([OPEN_ORDERS])),
                            await trustedProjectFrom(projectFileWith()),
                        ),
                        project,
                        targetId: firstOf(project.matrix).id,
                        baseUrl: RUN_ORIGIN,
                        seed: DEFAULT_SEED,
                        fixedTimeMilliseconds: DEFAULT_CLOCK_START,
                        fixtures: [],
                        host: { platform: "test", arch: "test" },
                    },
                    fakePorts({ drivers: driversOf(driver) }),
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.equal(driver.calls.count("open"), 1);
            });
        });

        describe("when a test replaces one", () => {
            test("then it should use that one and keep the others", () => {
                const driver = fakeDriver({
                    info: { id: "other", version: "1", protocol: "none" },
                });
                const ports = fakePorts({ drivers: driversOf(driver) });
                assert.equal(ports.drivers.get("other"), driver);
                assert.equal(Object.hasOwn(ports, "secrets"), true);
            });
        });

        describe("when a test leaves out an optional port", () => {
            test("then it should be absent from the ports", () => {
                const ports = leaveOut<RunPorts>(fakePorts(), ["services"]);
                assert.equal(Object.hasOwn(ports, "services"), false);
                assert.equal(Object.hasOwn(ports, "secrets"), true);
            });
        });
    });
});
