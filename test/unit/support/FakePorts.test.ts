import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    failure,
    planParser,
    run,
    runUntrusted,
    success,
    type Origin,
    type RunPorts,
    type Session,
    type SessionEnvironment,
    type Target,
} from "@revisum/engine";
import { fakeAdapterRegistry } from "#test-support/fakes/FakeAdapterRegistry.ts";
import { fakeDraftPlanner } from "#test-support/fakes/FakeDraftPlanner.ts";
import {
    fakeDriver,
    fakeDriverNeverLaunching,
    fakeDriverOpening,
} from "#test-support/fakes/FakeDriver.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { fakeEventSink } from "#test-support/fakes/FakeEventSink.ts";
import { fakeLeakScanner } from "#test-support/fakes/FakeLeakScanner.ts";
import { fakeRandom } from "#test-support/fakes/FakeRandom.ts";
import { FAKE_PAGE, fakeSession } from "#test-support/fakes/FakeSession.ts";
import { fakeStoragePort } from "#test-support/fakes/FakeStoragePort.ts";
import { leaveOut } from "#test-support/fakes/LeaveOut.ts";
import { authorise, trustedProjectFrom } from "#test-support/policy-clearance.ts";
import {
    finalState,
    guardedDriver,
    onlyRun,
    parserFor,
    runBase,
} from "../engine/guarded-driver.ts";
import { testProject } from "../engine/plan-examples.ts";
import {
    ALLOWED_UNNAMED_TEST_ID,
    OPEN_ACCOUNT_PAGE,
    click,
    planOf as planOnThePolicyProject,
    testId,
    withPolicy,
} from "../engine/policy-examples.ts";
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

const PORT_MEMBERS: readonly (keyof Session)[] = [
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

const DANGER_ZONE_STEPS = [OPEN_ACCOUNT_PAGE, click(testId("danger-zone-action"))];

describe("Using a fake port", () => {
    describe("given a fake session with nothing overridden", () => {
        describe("when a test asks what it offers", () => {
            test("then it should offer every member of the port", () => {
                const session = fakeSession();
                const missing = PORT_MEMBERS.filter((member) => !Object.hasOwn(session, member));
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
            test("then it should give a fake of its own, that notes the tab's calls apart", async () => {
                const session = fakeSession();
                const tab = await session.newTab("https://app.example/other");
                assert.ok(tab.ok);
                await tab.value.page();
                assert.equal(session.calls.count("page"), 0);
                const [openedTab] = session.openedTabs();
                assert.equal(openedTab?.calls.count("page"), 1);
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

    describe("given a plan clicking a control only a test id names", () => {
        describe("when it runs on the default fake", () => {
            test("then it should end Denied as an unnamed control, with the denial recorded", async () => {
                const audit = fakeEventSink();
                const outcome = await runUntrusted(
                    planOnThePolicyProject(DANGER_ZONE_STEPS),
                    parserFor(),
                    runBase(),
                    fakePorts({ audit }),
                );
                assert.equal(finalState(outcome), "Denied", JSON.stringify(outcome));
                assert.equal(onlyRun(outcome)?.denial?.rule, "unnamed-control");
                assert.equal(audit.calls.count("append"), 1);
            });
        });

        describe("when it runs on the guarded driver", () => {
            test("then it should end the same way as on the default fake", async () => {
                const driven = guardedDriver(DANGER_ZONE_STEPS);
                const outcome = await runUntrusted(
                    planOnThePolicyProject(DANGER_ZONE_STEPS),
                    parserFor(),
                    runBase(),
                    fakePorts({ drivers: driversOf(driven.driver) }),
                );
                assert.equal(finalState(outcome), "Denied", JSON.stringify(outcome));
                assert.equal(onlyRun(outcome)?.denial?.rule, "unnamed-control");
            });
        });

        describe("and a project that allows that test id", () => {
            describe("when it runs on the default fake", () => {
                test("then it should pass", async () => {
                    const steps = [OPEN_ACCOUNT_PAGE, click(testId(ALLOWED_UNNAMED_TEST_ID))];
                    const outcome = await runUntrusted(
                        planOnThePolicyProject(steps),
                        parserFor(withPolicy({})),
                        runBase(withPolicy({})),
                        fakePorts(),
                    );
                    assert.equal(finalState(outcome), "Passed", JSON.stringify(outcome));
                });
            });
        });
    });

    describe("given a fake adapter registry of one driver", () => {
        describe("when a test looks for that driver's id", () => {
            test("then it should find the driver and note the call", () => {
                const driver = fakeDriver();
                const registry = fakeAdapterRegistry([driver]);
                assert.equal(registry.find(TARGET.adapter), driver);
                assert.deepEqual(registry.all(), [driver]);
                assert.equal(registry.calls.count("find"), 1);
            });
        });

        describe("when a test looks for another id", () => {
            test("then it should find nothing", () => {
                const other = fakeDriver({
                    info: { id: "other", version: "1", protocol: "none" },
                });
                assert.equal(fakeAdapterRegistry([other]).find(TARGET.adapter), null);
            });
        });
    });

    describe("given a fake draft planner", () => {
        describe("when it is asked for a draft", () => {
            test("then it should reply with no text and note the request", async () => {
                const planner = fakeDraftPlanner();
                const request = { criteria: [], grammarVersion: "1", origins: [], targets: [] };
                assert.deepEqual(await planner.draft(request), {});
                assert.deepEqual(planner.calls.to("draft"), [
                    { method: "draft", arguments: [request] },
                ]);
            });
        });
    });

    describe("given a fake leak scanner", () => {
        describe("when it scans", () => {
            test("then it should find nothing and note the files", () => {
                const scanner = fakeLeakScanner();
                assert.deepEqual(scanner.scan(["result.json"], []), []);
                assert.deepEqual(scanner.calls.to("scan"), [
                    { method: "scan", arguments: [["result.json"], []] },
                ]);
            });
        });
    });

    describe("given fake randomness", () => {
        describe("when it is drawn from twice", () => {
            test("then it should give the same value each time", () => {
                const random = fakeRandom();
                assert.equal(random.next(), random.next());
                assert.equal(random.calls.count("next"), 2);
            });
        });
    });
});
