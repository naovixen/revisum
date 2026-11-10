// A clipboard's text past the project's limit is refused without keeping it. Waiting can't make the
// text fit any sooner than the next copy the page makes, and nothing is promised about that, so a
// check reads once and fails at once, as a remember does.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { success, type Session } from "@revisum/engine";
import { DEFAULT_MAXIMUM_CLIPBOARD_CHARACTERS } from "./examples/AdvanceClock.ts";
import {
    fakeSessionOnOrders,
    runOnFakeSession,
    stepSummaries,
} from "../../examples/RunOnFakeSession.ts";
import {
    OPEN_CART,
    unsafePlan,
    type JsonRecord,
} from "../../../plan/unsafe-features/examples/UnsafePlan.ts";

const OVER_LONG = "x".repeat(DEFAULT_MAXIMUM_CLIPBOARD_CHARACTERS + 1);
const AT_THE_LIMIT = "x".repeat(DEFAULT_MAXIMUM_CLIPBOARD_CHARACTERS);
const CLIPBOARD_STEP = 1;

const clipboardCheck = (kind: string, value: string): JsonRecord => ({
    type: "expectClipboard",
    assert: { kind, value },
    criterionId: "invite.link-copied",
});
const REMEMBER_CLIPBOARD: JsonRecord = {
    type: "remember",
    name: "copiedText",
    from: { clipboard: "text" },
};

type CountedClipboard = { readonly session: Session; readonly reads: () => number };

const clipboardHolding = (text: string): CountedClipboard => {
    let reads = 0;
    return {
        session: fakeSessionOnOrders({
            clipboard: {
                readText: () => {
                    reads += 1;
                    return Promise.resolve(success(text));
                },
            },
        }),
        reads: () => reads,
    };
};

const runStep = async (step: JsonRecord, text: string) => {
    const clipboard = clipboardHolding(text);
    const { result } = await runOnFakeSession(unsafePlan([OPEN_CART, step]), {
        session: clipboard.session,
    });
    return { summary: stepSummaries(result)[CLIPBOARD_STEP], reads: clipboard.reads() };
};

describe("Using a clipboard check", () => {
    for (const kind of ["textEquals", "textContains", "textExcludes"]) {
        describe(`given a ${kind} check and a clipboard holding text over the limit`, () => {
            describe("when the run reaches the check", () => {
                test("then it should fail with value-too-long after one read", async () => {
                    const done = await runStep(clipboardCheck(kind, "Ready"), OVER_LONG);
                    assert.deepEqual(done.summary, ["failed", "value-too-long"]);
                    assert.equal(done.reads, 1);
                });
            });
        });
    }

    describe("given a textContains check and a clipboard holding other text within the limit", () => {
        describe("when the run reaches the check", () => {
            test("then it should keep reading until the step times out", async () => {
                const done = await runStep(clipboardCheck("textContains", "Ready"), AT_THE_LIMIT);
                assert.deepEqual(done.summary, ["failed", "assertion-failed"]);
                assert.ok(done.reads > 1, `the clipboard was read ${done.reads} times`);
            });
        });
    });
});

describe("Using a remember from the clipboard", () => {
    describe("given a clipboard holding text over the limit", () => {
        describe("when the run reaches the step", () => {
            test("then it should fail with value-too-long after one read", async () => {
                const done = await runStep(REMEMBER_CLIPBOARD, OVER_LONG);
                assert.deepEqual(done.summary, ["failed", "value-too-long"]);
                assert.equal(done.reads, 1);
            });
        });
    });
});
