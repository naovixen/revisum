// What any session refuses before it touches the page.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSecret, success } from "@revisum/engine";
import type { JsonRecord } from "../browser/RawPlan.ts";
import {
    ANOTHER_SECRET_NAME,
    A_LEFT_REFERENCE,
    CLICK_EXPORT,
    EXPORT_BUTTON,
    FILL_THE_SECRET,
    HOLDING_A_VALUE,
    NAME_FIELD,
    SECRET_NAME,
    actionStep,
    allowing,
    assertNothingRead,
    downloadStep,
    failureCode,
    locatorOf,
    parsedSecretName,
    type OpenSessionUnderTest,
} from "./SessionUnderTest.ts";

const LEFT_REFERENCES: readonly (readonly [string, JsonRecord])[] = [
    ["a fill's value", { type: "fill", locator: NAME_FIELD, value: A_LEFT_REFERENCE }],
    ["a fill's locator", { type: "fill", locator: HOLDING_A_VALUE, value: "Ada" }],
    ["a click's locator", { type: "click", locator: HOLDING_A_VALUE }],
];
const FILL_ADA = { type: "fill", locator: NAME_FIELD, value: "Ada" };

function secretContract(open: OpenSessionUnderTest): void {
    describe("when a fill of a secret reference comes without its secret", () => {
        test("then it should answer not-actionable, having asked no guard", async () => {
            const { session } = await open();
            const { guard, asked } = allowing();
            const acted = await session.act(actionStep(FILL_THE_SECRET), guard);
            assert.equal(failureCode(acted), "not-actionable");
            assert.deepEqual(asked, []);
        });
    });

    describe("when a fill of a secret reference comes with another secret", () => {
        test("then it should answer not-actionable", async () => {
            const { session } = await open();
            const other = createSecret(parsedSecretName(ANOTHER_SECRET_NAME), "test-only-value");
            const acted = await session.act(actionStep(FILL_THE_SECRET), allowing().guard, other);
            assert.equal(failureCode(acted), "not-actionable");
        });
    });

    describe("when a fill of a secret reference comes with its secret", () => {
        test("then it should act", async () => {
            const { session } = await open();
            const secret = createSecret(parsedSecretName(SECRET_NAME), "test-only-value");
            const acted = await session.act(actionStep(FILL_THE_SECRET), allowing().guard, secret);
            assert.deepEqual(acted, success(undefined));
        });
    });
}

function valueReferenceContract(open: OpenSessionUnderTest): void {
    for (const [where, raw] of LEFT_REFERENCES) {
        describe(`when a value reference is left in ${where}`, () => {
            test("then it should answer unsupported-step, having asked no guard", async () => {
                const { session } = await open();
                const { guard, asked } = allowing();
                const acted = await session.act(actionStep(raw), guard);
                assert.equal(failureCode(acted), "unsupported-step");
                assert.deepEqual(asked, []);
            });
        });
    }

    describe("when a value reference is left in a download's locator", () => {
        test("then it should answer unsupported-step, having asked no guard", async () => {
            const { session } = await open();
            const { guard, asked } = allowing();
            const saved = await session.download?.(downloadStep(HOLDING_A_VALUE), 100, guard);
            assert.equal(failureCode(saved), "unsupported-step");
            assert.deepEqual(asked, []);
        });
    });

    describe("when a locator holding a value reference is probed", () => {
        test("then it should read nothing, not an empty page", async () => {
            const { session } = await open();
            assertNothingRead(await session.probe(locatorOf(HOLDING_A_VALUE)));
        });
    });

    describe("when the same steps hold no reference", () => {
        test("then it should act on them and read the element", async () => {
            const { session } = await open();
            const { guard } = allowing();
            assert.deepEqual(await session.act(actionStep(FILL_ADA), guard), success(undefined));
            assert.deepEqual(
                await session.act(actionStep(CLICK_EXPORT), guard),
                success(undefined),
            );
            assert.equal((await session.probe(locatorOf(EXPORT_BUTTON))).count, 1);
        });
    });
}

export function refusalsContract(open: OpenSessionUnderTest): void {
    describe("given a step no driver may perform", () => {
        secretContract(open);
        valueReferenceContract(open);
    });
}
