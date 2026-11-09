// A run that passes preflight runs with what preflight proved, so nothing after it looks anything up
// again: every fill of a secret carries its own secret, inside frames and second tabs too, and every
// page script the plan names runs with its own source. A plan naming a script whose source the run
// was not handed is refused before any step, with no manifest, as the manifest could not record it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createRunService,
    FillValueKind,
    planParser,
    success,
    type PageScriptCall,
    type RunResult,
} from "@revisum/engine";
import { baseUrlOf, clearRun, trustedProjectFrom } from "#test-support/builders/ClearRun.ts";
import { fakeDriverNeverLaunching } from "#test-support/fakes/session/FakeDriver.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { frame, newTab } from "../executors/clock-and-clipboard/examples/AdvanceClock.ts";
import { fakeSessionOnOrders, runOnFakeSession } from "../examples/RunOnFakeSession.ts";
import {
    DEFAULT_CLOCK_START,
    DEFAULT_SEED,
    accepted,
    recordingDriver,
} from "../values/examples/RunPlan.ts";
import { runWithSecrets, secretFillPlan } from "../../secrets/examples/SecretRun.ts";
import { parsedProject, sourceBytes } from "../../plan/unsafe-features/examples/LostByFeature.ts";
import {
    OPEN_CART,
    ORIGIN,
    READ_CART_FILE,
    SCRIPT_SOURCES,
    SEED_EDITOR,
    SEED_EDITOR_FILE,
    unsafePlan,
    unsafeProjectFile,
} from "../../plan/unsafe-features/examples/UnsafePlan.ts";

const FRAME_SECRET = "FRAME_ACCESS_CODE";
const TAB_SECRET = "TAB_ACCESS_CODE";
const secretFill = (name: string): Readonly<Record<string, unknown>> => ({
    type: "fill",
    locator: { by: "label", label: `Field for ${name}` },
    value: { secretName: name },
});

// The sign-in plan with one secret filled inside a frame and another inside a second tab.
const nestedSecretFillPlan = (): Readonly<Record<string, unknown>> => {
    const plan = secretFillPlan([]);
    const [opening, ...rest] = plan.steps;
    return {
        ...plan,
        steps: [
            opening,
            frame([secretFill(FRAME_SECRET)]),
            newTab([secretFill(TAB_SECRET)]),
            ...rest,
        ],
    };
};

// Runs the seed-editor plan, with the script also run inside a frame, handed only these sources, on a
// driver that records whether it was asked anything.
async function runWithScriptSources(
    sources: Readonly<Record<string, string>>,
): Promise<{ readonly result: RunResult; readonly driverCalls: number }> {
    const projectFile = unsafeProjectFile();
    const plan = accepted(
        planParser(parsedProject(projectFile)),
        unsafePlan([OPEN_CART, frame([SEED_EDITOR])]),
    );
    const [targetId = assert.fail("the test plan declares a target")] = plan.targets;
    const driver = fakeDriverNeverLaunching();
    const result = await createRunService(fakePorts({ drivers: driversOf(driver) })).run(
        clearRun(plan, await trustedProjectFrom(projectFile), targetId),
        {
            baseUrl: baseUrlOf(ORIGIN),
            seed: DEFAULT_SEED,
            fixedTimeMilliseconds: DEFAULT_CLOCK_START,
            fixtures: [],
            host: { platform: "test", arch: "test" },
            scriptSources: sourceBytes(sources),
        },
    );
    return { result, driverCalls: driver.calls.count() };
}

describe("Using the run", () => {
    describe("given a plan that fills one secret inside a frame and another inside a second tab", () => {
        describe("when the run passes preflight and reaches the fills", () => {
            test("then it should hand the driver each fill carrying its own secret, and pass", async () => {
                const { driver, recording } = recordingDriver();
                const { result } = await runWithSecrets(
                    [FRAME_SECRET, TAB_SECRET],
                    nestedSecretFillPlan(),
                    {
                        [FRAME_SECRET]: "test-only-frame-code",
                        [TAB_SECRET]: "test-only-tab-code",
                    },
                    driver,
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                const filledSecrets = recording.actions.flatMap((action) =>
                    action.type === "fill" && action.value.kind === FillValueKind.Secret
                        ? [action.value.secret.name]
                        : [],
                );
                assert.deepEqual(filledSecrets, [FRAME_SECRET, TAB_SECRET]);
            });
        });
    });

    describe("given a plan that runs a named page script on the page and inside a frame", () => {
        describe("when the run passes preflight and reaches the script steps", () => {
            test("then it should run the script with its own source each time", async () => {
                const calls: PageScriptCall[] = [];
                const session = fakeSessionOnOrders({
                    runScript: (call) => {
                        calls.push(call);
                        return Promise.resolve(success("null"));
                    },
                });
                const { result } = await runOnFakeSession(
                    unsafePlan([OPEN_CART, SEED_EDITOR, frame([SEED_EDITOR])]),
                    { session },
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.deepEqual(
                    calls.map((call) => call.source),
                    [SCRIPT_SOURCES[SEED_EDITOR_FILE], SCRIPT_SOURCES[SEED_EDITOR_FILE]],
                );
            });
        });
    });

    describe("given a plan that runs a named page script inside a frame", () => {
        describe("and the run is handed the source of another script but not of that one", () => {
            describe("when the run starts", () => {
                test("then it should refuse it with script-source-missing naming the file, before any step and with no manifest", async () => {
                    const { result, driverCalls } = await runWithScriptSources({
                        [READ_CART_FILE]:
                            SCRIPT_SOURCES[READ_CART_FILE] ?? assert.fail("no read-cart source"),
                    });
                    assert.equal(result.state, "Refused", JSON.stringify(result));
                    assert.deepEqual(result.refusal, {
                        code: "script-source-missing",
                        file: SEED_EDITOR_FILE,
                    });
                    assert.deepEqual(result.steps, []);
                    assert.equal(result.manifest, null);
                    assert.equal(result.manifestHash, null);
                    assert.equal(driverCalls, 0);
                });
            });
        });

        describe("and the run is handed that script's source", () => {
            describe("when the run starts", () => {
                test("then it should go past preflight and ask the driver for a browser", async () => {
                    const { result, driverCalls } = await runWithScriptSources(SCRIPT_SOURCES);
                    assert.equal(result.refusal, undefined, JSON.stringify(result.refusal));
                    assert.ok(driverCalls > 0);
                });
            });
        });
    });
});
