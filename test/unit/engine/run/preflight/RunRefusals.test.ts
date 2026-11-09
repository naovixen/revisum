// A run that cannot be honoured is refused before any side effect: no browser opens, nothing
// reaches the page and no command or call is made, so a test never acts in part. Each counter-example
// runs the same plan where it can be honoured.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    COUNT_ORDERS,
    OPEN_CART,
    SEED_ORDERS,
    WIPE_ORDERS,
    commandPlan,
    expectDatabase,
    modesOf,
    runWithCommands,
} from "../executors/database-commands/examples/Database.ts";
import {
    OPEN_ORDERS,
    ORIGIN,
    planOf,
    projectFileWith,
    recordingDriver,
    runPlan,
    type Recording,
} from "../values/examples/RunPlan.ts";
import { echoesIn, fakeStorageState, runWithSecrets, secretFillPlan } from "../../secrets/examples/SecretRun.ts";
import { parserEnabling, rejection } from "../../plan/unsafe-features/examples/LostByFeature.ts";

const SAVED_SESSION = "SAVED_SESSION";

const assertNothingReached = (recording: Recording): void => {
    assert.deepEqual(recording.environments, [], "a browser session was opened");
    assert.deepEqual(recording.navigations, [], "a navigation reached the driver");
    assert.deepEqual(recording.actions, [], "an action reached the driver");
    assert.equal(recording.probes, 0, "a check reached the driver");
};

describe("Using the run", () => {
    describe("given a proposal whose base URL is one of the project's production origins", () => {
        describe("when the run starts", () => {
            test("then it should refuse it with origin-not-allowed, naming the origin, before any browser opens", async () => {
                const projectFile = projectFileWith({ productionOrigins: [ORIGIN] });
                const { result, recording } = await runPlan(planOf([OPEN_ORDERS]), { projectFile });
                assert.equal(result.state, "Refused", JSON.stringify(result.steps));
                assert.deepEqual(result.refusal, { code: "origin-not-allowed", origin: ORIGIN });
                assertNothingReached(recording);
            });
        });
    });

    describe("given a plan that names saved storage state no driver can load", () => {
        const refusedRun = async () => {
            const state = fakeStorageState();
            const { driver, recording } = recordingDriver();
            const plan = secretFillPlan([], { storageState: { secretName: SAVED_SESSION } });
            const ran = await runWithSecrets(
                [SAVED_SESSION],
                plan,
                { [SAVED_SESSION]: state.json },
                driver,
            );
            return { ...ran, recording, state };
        };

        describe("when the run starts", () => {
            test("then it should refuse it with storage-state-unsupported", async () => {
                const { result } = await refusedRun();
                assert.equal(result.state, "Refused", JSON.stringify(result.steps));
                assert.deepEqual(result.refusal, { code: "storage-state-unsupported" });
            });

            test("then it should open no browser and send nothing to the page", async () => {
                const { recording } = await refusedRun();
                assertNothingReached(recording);
            });

            test("then it should run no step and make no manifest", async () => {
                const { result } = await refusedRun();
                assert.deepEqual(result.steps, []);
                assert.equal(result.manifest, null);
                assert.equal(result.manifestHash, null);
            });

            test("then it should keep no value of the state in its result or events", async () => {
                const { everything, state } = await refusedRun();
                const echoes = [
                    ...echoesIn(everything, state.cookieValue),
                    ...echoesIn(everything, state.tokenValue),
                ];
                assert.deepEqual(echoes, []);
            });
        });

        describe("when its secret is missing from the store as well", () => {
            test("then it should refuse it with secret-missing", async () => {
                const { driver, recording } = recordingDriver();
                const plan = secretFillPlan([], { storageState: { secretName: SAVED_SESSION } });
                const { result } = await runWithSecrets([SAVED_SESSION], plan, {}, driver);
                assert.equal(result.refusal?.code, "secret-missing");
                assertNothingReached(recording);
            });
        });
    });

    describe("given the same plan without saved storage state", () => {
        describe("when the run starts", () => {
            test("then it should reach the driver and pass", async () => {
                const { driver, recording } = recordingDriver();
                const { result } = await runWithSecrets(
                    [SAVED_SESSION],
                    secretFillPlan([]),
                    { [SAVED_SESSION]: fakeStorageState().json },
                    driver,
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.equal(recording.navigations.length, 1);
                assert.ok(recording.probes > 0);
            });
        });
    });

    describe("given a run with no database command runner wired in", () => {
        const countIsThree = expectDatabase("countOrders", "count", {
            kind: "numberEquals",
            value: 3,
        });
        const plansWithCommands = [
            {
                where: "a database step after a navigation",
                plan: commandPlan([OPEN_CART, COUNT_ORDERS]),
            },
            { where: "a write command", plan: commandPlan([OPEN_CART, SEED_ORDERS]) },
            { where: "an expectDatabase check", plan: commandPlan([OPEN_CART, countIsThree]) },
            // Cleanup that cannot run would leave the test data behind, so the steps never start.
            {
                where: "a command only in its cleanup",
                plan: commandPlan([OPEN_CART], [WIPE_ORDERS]),
            },
        ];

        for (const { where, plan } of plansWithCommands) {
            describe(`and a plan with ${where}`, () => {
                describe("when the run starts", () => {
                    test("then it should refuse it with database-commands-unavailable and reach nothing", async () => {
                        const { result, recording, commands } = await runWithCommands(plan, {
                            withPort: false,
                        });
                        assert.equal(result.state, "Refused", JSON.stringify(result.steps));
                        assert.deepEqual(result.refusal, { code: "database-commands-unavailable" });
                        assert.deepEqual(result.steps, []);
                        assertNothingReached(recording);
                        assert.deepEqual(commands, []);
                    });

                    test("then it should raise no review item and record no cleanup", async () => {
                        const { result } = await runWithCommands(plan, { withPort: false });
                        assert.equal(
                            Object.hasOwn(result, "reviewItems"),
                            false,
                            JSON.stringify(result.reviewItems),
                        );
                        assert.equal(
                            Object.hasOwn(result, "cleanup"),
                            false,
                            JSON.stringify(result.cleanup),
                        );
                    });
                });
            });
        }

        describe("and a plan with no database command", () => {
            describe("when the run starts", () => {
                test("then it should reach the driver and pass", async () => {
                    const { result, recording } = await runWithCommands(commandPlan([OPEN_CART]), {
                        withPort: false,
                    });
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    assert.equal(recording.navigations.length, 1);
                });
            });
        });
    });

    describe("given a run with a database command runner wired in", () => {
        describe("when its plan has a command in its steps and its cleanup", () => {
            test("then it should run both, in order", async () => {
                const { result, commands } = await runWithCommands(
                    commandPlan([OPEN_CART, COUNT_ORDERS], [WIPE_ORDERS]),
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.deepEqual(modesOf(commands), ["count", "wipe"]);
            });
        });
    });
});

// The run's walk also covers frames and second tabs, but no parsed plan can hold a command there, so
// only this refusal can show it.
describe("Using the plan parser", () => {
    const parse = parserEnabling();
    const frameLocator = { by: "label", label: "Checkout" };

    describe("given a database step inside a frame", () => {
        describe("when the plan is parsed", () => {
            test("then it should refuse the step as misplaced", () => {
                const plan = commandPlan([
                    OPEN_CART,
                    { type: "frame", locator: frameLocator, steps: [COUNT_ORDERS] },
                ]);
                assert.deepEqual(rejection(parse, plan), ["misplaced_step $.steps[1].steps[0]"]);
            });
        });
    });

    describe("given a database step inside a second tab", () => {
        describe("when the plan is parsed", () => {
            test("then it should refuse the step as misplaced", () => {
                const plan = commandPlan([
                    OPEN_CART,
                    { type: "newTab", url: "/cart", steps: [COUNT_ORDERS] },
                ]);
                assert.deepEqual(rejection(parse, plan), ["misplaced_step $.steps[1].steps[0]"]);
            });
        });
    });
});
