// A result holds what a page script or a database command remembered in one of two published fields:
// one value on its own under `remembered`, several under `rememberedValues`, and neither when there
// is none. Result hashes depend on it, so an empty list or a list of one must never appear.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sha256, success, type StepResult } from "@revisum/engine";
import { copyOf } from "../executors/network-and-storage/examples/Stubs.ts";
import {
    fakeSessionOnOrders,
    runOnFakeSession,
    type FakeRunOptions,
} from "../examples/RunOnFakeSession.ts";
import {
    DATABASE_COMMANDS,
    FEATURES,
    OPEN_CART,
    PAGE_SCRIPTS,
    READ_CART_FILE,
    SEED_EDITOR,
    SEED_ORDERS,
    unsafePlan,
    unsafeProjectFile,
    unsafeSection,
    type JsonRecord,
} from "../../plan/unsafe-features/examples/UnsafePlan.ts";

const READ_VALUES = { first: "alpha", second: "beta", third: "gamma" };
const READ_VALUES_JSON = JSON.stringify(READ_VALUES);
const FIELD_POINTERS = { first: "/first", second: "/second", third: "/third" };

const recordOf = (valueName: string, text: string) => ({ valueName, sha256: sha256(text) });
const FIRST = recordOf("firstValue", READ_VALUES.first);
const SECOND = recordOf("secondValue", READ_VALUES.second);
const THIRD = recordOf("thirdValue", READ_VALUES.third);

const REMEMBERING_STEP_INDEX = 1;

const PROJECT_FILE = unsafeProjectFile(FEATURES, {
    unsafeFeatures: {
        ...unsafeSection(FEATURES),
        pageScripts: {
            allowInline: true,
            scripts: {
                ...PAGE_SCRIPTS,
                readOrder: {
                    file: READ_CART_FILE,
                    parameters: {},
                    effect: "read",
                    fields: FIELD_POINTERS,
                    allowInProposals: false,
                },
            },
        },
        databaseCommands: {
            commands: {
                ...DATABASE_COMMANDS,
                readOrder: { ...copyOf(DATABASE_COMMANDS, "countOrders"), fields: FIELD_POINTERS },
            },
        },
    },
});

const ROUTES: readonly {
    readonly name: string;
    readonly rememberingNothing: JsonRecord;
    readonly remembering: (remember: JsonRecord) => JsonRecord;
    readonly optionsOfOneRun: () => FakeRunOptions;
}[] = [
    {
        name: "a page script",
        rememberingNothing: SEED_EDITOR,
        remembering: (remember) => ({
            type: "evaluate",
            script: "readOrder",
            arguments: {},
            remember,
        }),
        optionsOfOneRun: () => ({
            projectFile: PROJECT_FILE,
            session: fakeSessionOnOrders({
                runScript: () => Promise.resolve(success(READ_VALUES_JSON)),
            }),
        }),
    },
    {
        name: "a database command",
        rememberingNothing: SEED_ORDERS,
        remembering: (remember) => ({
            type: "database",
            command: "readOrder",
            arguments: { email: "ada@example.com" },
            remember,
        }),
        optionsOfOneRun: () => ({
            projectFile: PROJECT_FILE,
            commandRoute: () => ({ stdout: READ_VALUES_JSON }),
        }),
    },
];

const REMEMBER_FIRST = { firstValue: "first" };
const REMEMBER_SECOND_THEN_FIRST = { secondValue: "second", firstValue: "first" };
const REMEMBER_ALL_THREE = { firstValue: "first", secondValue: "second", thirdValue: "third" };

const stepResultOf = async (step: JsonRecord, options: FakeRunOptions): Promise<StepResult> => {
    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART, step]), options);
    const stepResult = result.steps[REMEMBERING_STEP_INDEX];
    assert.equal(stepResult?.outcome, "passed", JSON.stringify(result.steps));
    return stepResult;
};

const rememberedFieldsOf = (stepResult: StepResult): Readonly<Record<string, unknown>> =>
    Object.fromEntries(Object.entries(stepResult).filter(([key]) => key.startsWith("remembered")));

describe("Using a run that remembers values from a step", () => {
    for (const { name, rememberingNothing, remembering, optionsOfOneRun } of ROUTES) {
        describe(`given ${name} that remembers nothing`, () => {
            describe("when the step's result is serialised", () => {
                test("then it should hold neither field", async () => {
                    const stepResult = await stepResultOf(rememberingNothing, optionsOfOneRun());
                    const keys = Object.keys(JSON.parse(JSON.stringify(stepResult)) as object);
                    assert.deepEqual(
                        keys.filter((key) => key.startsWith("remembered")),
                        [],
                    );
                });

                test("then it should hold no key set to undefined", async () => {
                    const stepResult = await stepResultOf(rememberingNothing, optionsOfOneRun());
                    assert.deepEqual(rememberedFieldsOf(stepResult), {});
                });
            });
        });

        describe(`given ${name} that remembers one value`, () => {
            describe("when the step's result is read", () => {
                test("then it should hold the record on its own, with no list", async () => {
                    const stepResult = await stepResultOf(
                        remembering(REMEMBER_FIRST),
                        optionsOfOneRun(),
                    );
                    assert.deepEqual(rememberedFieldsOf(stepResult), { remembered: FIRST });
                });
            });
        });

        describe(`given ${name} that remembers two values`, () => {
            describe("when the step's result is read", () => {
                test("then it should hold both in a list, in the plan's order, with no single record", async () => {
                    const stepResult = await stepResultOf(
                        remembering(REMEMBER_SECOND_THEN_FIRST),
                        optionsOfOneRun(),
                    );
                    assert.deepEqual(rememberedFieldsOf(stepResult), {
                        rememberedValues: [SECOND, FIRST],
                    });
                });
            });
        });

        describe(`given ${name} that remembers three values`, () => {
            describe("when the step's result is read", () => {
                test("then it should hold all three in a list, in the plan's order", async () => {
                    const stepResult = await stepResultOf(
                        remembering(REMEMBER_ALL_THREE),
                        optionsOfOneRun(),
                    );
                    assert.deepEqual(rememberedFieldsOf(stepResult), {
                        rememberedValues: [FIRST, SECOND, THIRD],
                    });
                });
            });
        });
    }
});
