// What any session does with a step the engine resolved for it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSecret, success } from "@revisum/engine";
import {
    CLICK_EXPORT,
    EXPORT_BUTTON,
    FILL_THE_SECRET,
    NAME_FIELD,
    SECRET_NAME,
    actionStep,
    allowing,
    locatorOf,
    parsedSecretName,
    type OpenSessionUnderTest,
} from "./SessionUnderTest.ts";

const FILL_ADA = { type: "fill", locator: NAME_FIELD, value: "Ada" };

// A fill of a secret or of a value reference that reaches a driver unresolved, or without its secret,
// cannot be written against the driver's ports: DriverTypeGuarantees.ts proves it. What is left
// for a session to show is that it performs what it is handed.
function secretContract(open: OpenSessionUnderTest): void {
    describe("when a fill comes carrying its secret", () => {
        test("then it should act", async () => {
            const { session } = await open();
            const secret = createSecret(parsedSecretName(SECRET_NAME), "test-only-value");
            const acted = await session.act(actionStep(FILL_THE_SECRET, secret), allowing().guard);
            assert.deepEqual(acted, success(undefined));
        });
    });
}

function resolvedStepContract(open: OpenSessionUnderTest): void {
    describe("when the steps hold only literal text", () => {
        test("then it should act on them and read the element", async () => {
            const { session } = await open();
            const { guard } = allowing();
            assert.deepEqual(await session.act(actionStep(FILL_ADA), guard), success(undefined));
            assert.deepEqual(
                await session.act(actionStep(CLICK_EXPORT), guard),
                success(undefined),
            );
            assert.equal((await session.probe(locatorOf(EXPORT_BUTTON), null)).count, 1);
        });
    });
}

export function refusalsContract(open: OpenSessionUnderTest): void {
    describe("given a step the engine resolved", () => {
        secretContract(open);
        resolvedStepContract(open);
    });
}
