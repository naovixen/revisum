// Every "can this run at all" check is made before any side effect, in one fixed order, and a run
// that fails several reports the first. Each pair here is two neighbouring checks a run fails at
// once: the refusal is always the earlier one's, and no driver is asked anything.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planParser, run, type RunPorts, type RunResult } from "@revisum/engine";
import { baseUrlOf, clearRun, trustedProjectFrom } from "#test-support/policy-clearance.ts";
import { fakeDriverNeverLaunching } from "#test-support/fakes/FakeDriver.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { fakeSecretStore } from "#test-support/fakes/FakeSecretStore.ts";
import { leaveOut } from "#test-support/fakes/LeaveOut.ts";
import { TEST_SERVICE_SECRET_NAMES } from "./plan-examples.ts";
import { DEFAULT_CLOCK_START, DEFAULT_SEED, accepted } from "./run-value-examples.ts";
import { fakeStorageState } from "./secret-examples.ts";
import { parsedProject, sourceBytes } from "./unsafe-feature-examples.ts";
import {
    DATABASE_SECRET,
    FEATURES,
    OPEN_CART,
    ORIGIN,
    SEED_EDITOR,
    SEED_ORDERS,
    unsafePlan,
    unsafeProjectFile,
    type JsonRecord,
} from "./unsafe-feature-steps.ts";

const PRODUCTION_ORIGIN = "https://shop.example.com";
const TOKEN = "SHOP_API_TOKEN";
const SAVED_SESSION = "SAVED_SESSION";

const PROJECT_FILE = unsafeProjectFile(FEATURES, {
    origins: [ORIGIN, PRODUCTION_ORIGIN],
    productionOrigins: [PRODUCTION_ORIGIN],
    secretNames: [...TEST_SERVICE_SECRET_NAMES, DATABASE_SECRET, SAVED_SESSION],
});

const EVERY_SECRET: Readonly<Record<string, string>> = {
    [TOKEN]: "test-only-token-value",
    [DATABASE_SECRET]: "test-only-database-password",
    [SAVED_SESSION]: fakeStorageState().json,
};

// One reason a run cannot go ahead: what the plan holds and what the run is handed to fail it.
type Condition = {
    readonly code: string;
    readonly steps?: readonly JsonRecord[];
    readonly planFields?: JsonRecord;
    readonly baseUrl?: string;
    readonly missingSecret?: string;
    readonly withoutScriptSources?: true;
    readonly withoutServices?: true;
    readonly withoutDatabaseCommands?: true;
};

// In the order the run checks them.
const CONDITIONS: readonly Condition[] = [
    { code: "origin-not-allowed", baseUrl: PRODUCTION_ORIGIN },
    {
        code: "secret-missing",
        steps: [
            {
                type: "fill",
                locator: { by: "label", label: "Token" },
                value: { secretName: TOKEN },
            },
        ],
        missingSecret: TOKEN,
    },
    { code: "script-source-missing", steps: [SEED_EDITOR], withoutScriptSources: true },
    {
        code: "services-unavailable",
        steps: [{ type: "call", call: "resetShop", arguments: {} }],
        withoutServices: true,
    },
    {
        code: "storage-state-unsupported",
        planFields: { storageState: { secretName: SAVED_SESSION } },
    },
    {
        code: "element-check-unsupported",
        steps: [
            {
                type: "expect",
                locator: { by: "testId", testId: "agree" },
                assert: { kind: "checked" },
                criterionId: "cart.terms-agreed",
            },
        ],
    },
    { code: "database-commands-unavailable", steps: [SEED_ORDERS], withoutDatabaseCommands: true },
];

const ALL_CODES = CONDITIONS.map((condition) => condition.code);

function portsFor(
    conditions: readonly Condition[],
    driverPorts: Pick<RunPorts, "drivers">,
): RunPorts {
    const missing = new Set(conditions.flatMap((condition) => condition.missingSecret ?? []));
    const secrets = Object.fromEntries(
        Object.entries(EVERY_SECRET).filter(([name]) => !missing.has(name)),
    );
    const ports = fakePorts({ ...driverPorts, secrets: fakeSecretStore(secrets) });
    return leaveOut<RunPorts>(ports, [
        ...(conditions.some((condition) => condition.withoutServices)
            ? (["services"] as const)
            : []),
        ...(conditions.some((condition) => condition.withoutDatabaseCommands)
            ? (["databaseCommands"] as const)
            : []),
    ]);
}

// Runs one plan failing every condition given, on a driver that records whether it was asked.
async function runFailing(
    conditions: readonly Condition[],
): Promise<{ readonly result: RunResult; readonly driverCalls: number }> {
    const plan = accepted(
        planParser(parsedProject(PROJECT_FILE)),
        unsafePlan(
            [OPEN_CART, ...conditions.flatMap((condition) => condition.steps ?? [])],
            conditions.reduce<JsonRecord>(
                (fields, condition) => ({ ...fields, ...condition.planFields }),
                {},
            ),
        ),
    );
    const [targetId = assert.fail("the test plan declares a target")] = plan.targets;
    const cleared = clearRun(plan, await trustedProjectFrom(PROJECT_FILE), targetId);
    const driver = fakeDriverNeverLaunching();
    const baseUrl =
        conditions.find((condition) => condition.baseUrl !== undefined)?.baseUrl ?? ORIGIN;
    const result = await run(
        cleared,
        {
            baseUrl: baseUrlOf(baseUrl),
            seed: DEFAULT_SEED,
            fixedTimeMilliseconds: DEFAULT_CLOCK_START,
            fixtures: [],
            host: { platform: "test", arch: "test" },
            scriptSources: conditions.some((condition) => condition.withoutScriptSources)
                ? {}
                : sourceBytes(),
        },
        portsFor(conditions, { drivers: driversOf(driver) }),
    );
    return { result, driverCalls: driver.calls.count() };
}

describe("Using the run", () => {
    for (const condition of CONDITIONS) {
        describe(`given a plan that fails only the ${condition.code} check`, () => {
            describe("when the run starts", () => {
                test(`then it should refuse it with ${condition.code}, asking no driver anything`, async () => {
                    const { result, driverCalls } = await runFailing([condition]);
                    assert.equal(result.state, "Refused", JSON.stringify(result));
                    assert.equal(result.refusal?.code, condition.code);
                    assert.equal(driverCalls, 0);
                });
            });
        });
    }

    for (const [index, earlier] of CONDITIONS.entries()) {
        const later = CONDITIONS[index + 1];
        if (later === undefined) {
            continue;
        }
        describe(`given a plan that fails the ${earlier.code} and ${later.code} checks`, () => {
            describe("when the run starts", () => {
                test(`then it should refuse it with ${earlier.code}, the check made first`, async () => {
                    const { result, driverCalls } = await runFailing([later, earlier]);
                    assert.equal(result.refusal?.code, earlier.code, JSON.stringify(result));
                    assert.equal(driverCalls, 0);
                });
            });
        });
    }

    describe("given a plan that fails every check", () => {
        describe("when the run starts", () => {
            test(`then it should refuse it with ${ALL_CODES[0] ?? "the first check"}`, async () => {
                const { result } = await runFailing(CONDITIONS.toReversed());
                assert.equal(result.refusal?.code, ALL_CODES[0]);
            });
        });
    });

    describe("given a plan that fails no check", () => {
        describe("when the run starts", () => {
            test("then it should ask the driver for a browser", async () => {
                const { result, driverCalls } = await runFailing([]);
                assert.equal(result.refusal, undefined, JSON.stringify(result.refusal));
                assert.ok(driverCalls > 0);
            });
        });
    });
});
