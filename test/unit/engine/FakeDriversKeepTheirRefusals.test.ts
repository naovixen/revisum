// The fakes that shape what a page does still refuse what no driver may perform, so a step a real driver
// would refuse cannot pass on them, and a guard or a field never sees it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createSecret,
    type BrowserDriver,
    type GuardVerdict,
    type Session,
    type SessionEnvironment,
} from "@revisum/engine";
import {
    A_LEFT_REFERENCE,
    actionStep,
    CLICK_EXPORT,
    FILL_THE_SECRET,
    HOLDING_A_VALUE,
    locatorOf,
    NAME_FIELD,
    parsedSecretName,
    SECRET_NAME,
} from "#test-support/session-contract/SessionUnderTest.ts";
import { echoPageDriver } from "./echo-page-driver.ts";
import { guardedDriver } from "./guarded-driver.ts";
import { testProject } from "./plan-examples.ts";

const ALLOW: GuardVerdict = { kind: "allow" };
const SECRET_VALUE = "test-only-value";
const FILL_LEFT_WITH_A_REFERENCE = { type: "fill", locator: NAME_FIELD, value: A_LEFT_REFERENCE };
const CLICK_LEFT_WITH_A_REFERENCE = { type: "click", locator: HOLDING_A_VALUE };

const ENVIRONMENT: SessionEnvironment = {
    baseUrl: "https://app.example",
    allowedOrigins: [],
    seed: 7,
    fixedTimeMilliseconds: 0,
    sensitiveSelectors: [],
    timeoutMilliseconds: 1000,
};

async function opened(driver: BrowserDriver): Promise<Session> {
    const [target = assert.fail("the test project declares a target")] = testProject().matrix;
    const session = await driver.open(target, ENVIRONMENT);
    assert.ok(session.ok, JSON.stringify(session));
    return session.value;
}

const codeOf = (acted: Awaited<ReturnType<Session["act"]>>): string =>
    acted.ok ? "acted" : acted.error.code;

describe("Using a fake driver that shapes the page", () => {
    describe("given the guarded driver", () => {
        const refusedOn = async (raw: typeof CLICK_EXPORT) => {
            const driven = guardedDriver([raw]);
            const session = await opened(driven.driver);
            const code = codeOf(await session.act(actionStep(raw), () => ALLOW));
            return { code, guardCalls: driven.guardCalls(), inputEvents: driven.inputEvents };
        };

        describe("when a click still holds a value reference", () => {
            test("then it should refuse the step, with no guard asked and no input sent", async () => {
                assert.deepEqual(await refusedOn(CLICK_LEFT_WITH_A_REFERENCE), {
                    code: "unsupported-step",
                    guardCalls: 0,
                    inputEvents: [0],
                });
            });
        });

        describe("when a fill of a secret reference comes without its secret", () => {
            test("then it should refuse the step, with no guard asked and no input sent", async () => {
                assert.deepEqual(await refusedOn(FILL_THE_SECRET), {
                    code: "not-actionable",
                    guardCalls: 0,
                    inputEvents: [0],
                });
            });
        });

        describe("when a click holds no reference", () => {
            test("then it should ask the guard and send the input", async () => {
                assert.deepEqual(await refusedOn(CLICK_EXPORT), {
                    code: "acted",
                    guardCalls: 1,
                    inputEvents: [1],
                });
            });
        });
    });

    describe("given the echo page", () => {
        describe("when a fill still holds a value reference", () => {
            test("then it should refuse the step, and keep nothing in the field", async () => {
                const driver = echoPageDriver({});
                const session = await opened(driver);
                const acted = await session.act(
                    actionStep(FILL_LEFT_WITH_A_REFERENCE),
                    () => ALLOW,
                );
                assert.equal(codeOf(acted), "unsupported-step");
                assert.equal(driver.fieldValues.size, 0);
            });
        });

        describe("when a fill of a secret reference comes without its secret", () => {
            test("then it should refuse the step, and keep nothing in the field", async () => {
                const driver = echoPageDriver({ secretValues: { [SECRET_NAME]: SECRET_VALUE } });
                const session = await opened(driver);
                const acted = await session.act(actionStep(FILL_THE_SECRET), () => ALLOW);
                assert.equal(codeOf(acted), "not-actionable");
                assert.equal(driver.fieldValues.size, 0);
            });
        });

        describe("when a fill of a secret reference comes with its secret", () => {
            test("then it should keep the secret's value in the field", async () => {
                const driver = echoPageDriver({ secretValues: { [SECRET_NAME]: SECRET_VALUE } });
                const session = await opened(driver);
                const secret = createSecret(parsedSecretName(SECRET_NAME), SECRET_VALUE);
                const acted = await session.act(actionStep(FILL_THE_SECRET), () => ALLOW, secret);
                assert.equal(codeOf(acted), "acted");
                assert.deepEqual([...driver.fieldValues.values()], [SECRET_VALUE]);
            });
        });

        describe("when a locator holding a value reference is probed", () => {
            test("then it should read nothing of the page", async () => {
                const driver = echoPageDriver({});
                const session = await opened(driver);
                const probed = await session.probe(locatorOf(HOLDING_A_VALUE), null);
                assert.equal(probed.count, "page-unreadable");
                assert.equal(driver.calls.probes, 1);
            });
        });
    });
});
