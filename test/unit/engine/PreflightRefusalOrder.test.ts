// Every "can this run at all" check is made before any side effect, in one fixed order, and a run
// that fails several reports the first. Each pair here is two neighbouring checks a run fails at
// once: the refusal is always the earlier one's, and no driver is asked anything.
//
// The policy gate keeps a production origin out of every step and call, so only a base URL brings
// one to preflight, and a base URL fails both origin checks at once only when it is a production
// origin the project does not list, where both name that one origin. The base URL check is paired
// with the first check after the production origin instead, and a run failing several conditions
// takes the base URL of the earliest.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRunService, planParser, type RunPorts, type RunResult } from "@revisum/engine";
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
const UNDECLARED_ORIGIN = "https://elsewhere.example.org";
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
    readonly check: string;
    readonly code: string;
    // The origin a refusal of this check names, so two checks refusing with one code tell apart.
    readonly origin?: string;
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
    {
        check: "base URL off the project's origins",
        code: "origin-not-allowed",
        origin: UNDECLARED_ORIGIN,
        baseUrl: `${UNDECLARED_ORIGIN}/app/`,
    },
    {
        check: "production origin",
        code: "origin-not-allowed",
        origin: PRODUCTION_ORIGIN,
        baseUrl: PRODUCTION_ORIGIN,
    },
    {
        check: "secret",
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
    {
        check: "page script source",
        code: "script-source-missing",
        steps: [SEED_EDITOR],
        withoutScriptSources: true,
    },
    {
        check: "services",
        code: "services-unavailable",
        steps: [{ type: "call", call: "resetShop", arguments: {} }],
        withoutServices: true,
    },
    {
        check: "storage state",
        code: "storage-state-unsupported",
        planFields: { storageState: { secretName: SAVED_SESSION } },
    },
    {
        check: "element check",
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
    {
        check: "database commands",
        code: "database-commands-unavailable",
        steps: [SEED_ORDERS],
        withoutDatabaseCommands: true,
    },
];

const [FIRST_CHECK = assert.fail("there is a first check")] = CONDITIONS;

// Refused by this condition's check: its code, and the origin it names when it names one.
const assertRefusedBy = (result: RunResult, condition: Condition): void => {
    assert.equal(result.state, "Refused", JSON.stringify(result));
    assert.equal(result.refusal?.code, condition.code, JSON.stringify(result.refusal));
    if (condition.origin !== undefined) {
        assert.deepEqual(result.refusal, { code: condition.code, origin: condition.origin });
    }
};

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
        CONDITIONS.find(
            (condition) => conditions.includes(condition) && condition.baseUrl !== undefined,
        )?.baseUrl ?? ORIGIN;
    const result = await createRunService(portsFor(conditions, { drivers: driversOf(driver) })).run(
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
    );
    return { result, driverCalls: driver.calls.count() };
}

describe("Using the run", () => {
    for (const condition of CONDITIONS) {
        describe(`given a plan that fails only the ${condition.check} check`, () => {
            describe("when the run starts", () => {
                test(`then it should refuse it with ${condition.code}, asking no driver anything`, async () => {
                    const { result, driverCalls } = await runFailing([condition]);
                    assertRefusedBy(result, condition);
                    assert.equal(driverCalls, 0);
                });
            });
        });
    }

    for (const [index, earlier] of CONDITIONS.entries()) {
        // One run has one base URL, so two conditions that each set it never pair.
        const later = CONDITIONS.slice(index + 1).find(
            (condition) => earlier.baseUrl === undefined || condition.baseUrl === undefined,
        );
        if (later === undefined) {
            continue;
        }
        describe(`given a plan that fails the ${earlier.check} and ${later.check} checks`, () => {
            describe("when the run starts", () => {
                test(`then it should refuse it with ${earlier.code}, the ${earlier.check} check made first`, async () => {
                    const { result, driverCalls } = await runFailing([later, earlier]);
                    assertRefusedBy(result, earlier);
                    assert.equal(driverCalls, 0);
                });
            });
        });
    }

    describe("given a plan that fails every check", () => {
        describe("when the run starts", () => {
            test(`then it should refuse it with ${FIRST_CHECK.code}, the ${FIRST_CHECK.check} check`, async () => {
                const { result } = await runFailing(CONDITIONS.toReversed());
                assertRefusedBy(result, FIRST_CHECK);
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
