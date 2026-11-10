// A capture after a secret was typed in has to hide that field. A field missing from a page that still
// answers cannot be hidden, so the image is left out and the step passes without it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DriverErrorCode, failure } from "@revisum/engine";
import { fakeSessionOnOrders, runOnFakeSession } from "../../examples/RunOnFakeSession.ts";
import {
    DATABASE_SECRET,
    OPEN_CART,
    unsafePlan,
    type JsonRecord,
} from "../../../plan/unsafe-features/examples/UnsafePlan.ts";

const FILL_THE_SECRET: JsonRecord = {
    type: "fill",
    locator: { by: "label", label: "Access code" },
    value: { secretName: DATABASE_SECRET },
};
const CAPTURE_THE_CART: JsonRecord = { type: "capture", name: "cart" };
const CAPTURE_STEP = 2;

describe("Using a capture step after a secret was typed into a field", () => {
    describe("given a page that still answers, where that field cannot be found to hide it", () => {
        describe("when the run ends", () => {
            test("then it should pass the step with its image left out", async () => {
                const { result } = await runOnFakeSession(
                    unsafePlan([OPEN_CART, FILL_THE_SECRET, CAPTURE_THE_CART]),
                    {
                        session: fakeSessionOnOrders({
                            screenshotHidingFields: () =>
                                Promise.resolve(
                                    failure({
                                        code: DriverErrorCode.NotFound,
                                        detail: "a field a secret was typed into cannot be found to hide it",
                                    }),
                                ),
                        }),
                    },
                );
                const captured = result.steps[CAPTURE_STEP];
                assert.deepEqual(
                    {
                        state: result.state,
                        outcome: captured?.outcome,
                        code: captured?.code,
                        artifact: captured?.artifact,
                    },
                    {
                        state: "Passed",
                        outcome: "passed",
                        code: "capture-left-out",
                        artifact: undefined,
                    },
                );
            });
        });
    });
});
