// A result holds what a step remembered in one of two published fields: one value on its own under
// `remembered`, several under `rememberedValues`, and neither when there is none. Result hashes
// depend on it, so an empty list or a list of one must never appear.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { INVALID, sha256 } from "@revisum/engine";
import { readValueName } from "../../../packages/engine/src/plan/plan-values.ts";
import {
    recordsOfRemembered,
    type RememberedRecord,
} from "../../../packages/engine/src/RememberedValues.ts";

function recordOf(name: string): RememberedRecord {
    const valueName = readValueName(name, "$", []);
    if (valueName === INVALID) {
        assert.fail(`not a value name: ${name}`);
    }
    return { valueName, sha256: sha256(name) };
}

const FIRST = recordOf("firstValue");
const SECOND = recordOf("secondValue");
const THIRD = recordOf("thirdValue");

describe("Using recordsOfRemembered", () => {
    describe("given no records", () => {
        describe("when the result's fields are made", () => {
            test("then it should hold neither field", () => {
                assert.equal(JSON.stringify(recordsOfRemembered([])), "{}");
            });

            test("then it should hold no key set to undefined", () => {
                assert.deepEqual(Object.keys(recordsOfRemembered([])), []);
            });
        });
    });

    describe("given one record", () => {
        describe("when the result's fields are made", () => {
            test("then it should hold the record on its own, with no list", () => {
                assert.deepEqual(recordsOfRemembered([FIRST]), { remembered: FIRST });
            });
        });
    });

    describe("given two records", () => {
        describe("when the result's fields are made", () => {
            test("then it should hold both in a list, in their order, with no single record", () => {
                assert.deepEqual(recordsOfRemembered([SECOND, FIRST]), {
                    rememberedValues: [SECOND, FIRST],
                });
            });
        });
    });

    describe("given three records", () => {
        describe("when the result's fields are made", () => {
            test("then it should hold all three in a list, in their order", () => {
                assert.deepEqual(recordsOfRemembered([FIRST, SECOND, THIRD]), {
                    rememberedValues: [FIRST, SECOND, THIRD],
                });
            });
        });
    });
});
