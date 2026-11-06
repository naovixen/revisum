// The fakes that shape what a page does perform the resolved step they are handed, as a real driver
// does: a step still holding a value reference, or a fill of a secret without the secret, cannot be
// written against the driver's ports (DriverTypeGuarantees.ts), so none can pass on them.
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
    actionStep,
    CLICK_EXPORT,
    FILL_THE_SECRET,
    NAME_FIELD,
    parsedSecretName,
    SECRET_NAME,
} from "#test-support/session-contract/SessionUnderTest.ts";
import { echoPageDriver } from "./echo-page-driver.ts";
import { guardedDriver } from "./guarded-driver.ts";
import { testProject } from "./plan-examples.ts";
import { baseUrlOf } from "#test-support/policy-clearance.ts";

const ALLOW: GuardVerdict = { kind: "allow" };
const SECRET_VALUE = "test-only-value";
const FILL_ADA = { type: "fill", locator: NAME_FIELD, value: "Ada" };

const ENVIRONMENT: SessionEnvironment = {
    baseUrl: baseUrlOf("https://app.example"),
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

const theSecret = () => createSecret(parsedSecretName(SECRET_NAME), SECRET_VALUE);

describe("Using a fake driver that shapes the page", () => {
    describe("given the guarded driver", () => {
        describe("when a click is handed to it", () => {
            test("then it should ask the guard and send the input", async () => {
                const driven = guardedDriver([CLICK_EXPORT]);
                const session = await opened(driven.driver);
                const code = codeOf(await session.act(actionStep(CLICK_EXPORT), () => ALLOW));
                assert.deepEqual(
                    { code, guardCalls: driven.guardCalls(), inputEvents: driven.inputEvents },
                    { code: "acted", guardCalls: 1, inputEvents: [1] },
                );
            });
        });

        describe("when a fill carrying its secret is handed to it", () => {
            test("then it should ask the guard and send the input", async () => {
                const driven = guardedDriver([FILL_THE_SECRET]);
                const session = await opened(driven.driver);
                const acted = await session.act(
                    actionStep(FILL_THE_SECRET, theSecret()),
                    () => ALLOW,
                );
                assert.deepEqual(
                    {
                        code: codeOf(acted),
                        guardCalls: driven.guardCalls(),
                        inputEvents: driven.inputEvents,
                    },
                    { code: "acted", guardCalls: 1, inputEvents: [1] },
                );
            });
        });
    });

    describe("given the echo page", () => {
        describe("when a fill of literal text is handed to it", () => {
            test("then it should keep that text in the field", async () => {
                const driver = echoPageDriver({});
                const session = await opened(driver);
                const acted = await session.act(actionStep(FILL_ADA), () => ALLOW);
                assert.equal(codeOf(acted), "acted");
                assert.deepEqual([...driver.fieldValues.values()], ["Ada"]);
            });
        });

        describe("when a fill carrying its secret is handed to it", () => {
            test("then it should keep the secret's value in the field", async () => {
                const driver = echoPageDriver({ secretValues: { [SECRET_NAME]: SECRET_VALUE } });
                const session = await opened(driver);
                const acted = await session.act(
                    actionStep(FILL_THE_SECRET, theSecret()),
                    () => ALLOW,
                );
                assert.equal(codeOf(acted), "acted");
                assert.deepEqual([...driver.fieldValues.values()], [SECRET_VALUE]);
            });
        });
    });
});
