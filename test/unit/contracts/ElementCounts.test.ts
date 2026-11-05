// A read of one element holds what a read of no single element can't: its states, link and DOM read.
// These two checks are what tell them apart, so a read can't pose as the other.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isOneElementRead, isSeveralElements, type ElementsRead } from "@revisum/contracts";

const COUNTS: readonly { readonly count: number; readonly isSeveral: boolean }[] = [
    { count: 0, isSeveral: false },
    { count: 1, isSeveral: false },
    { count: 2, isSeveral: true },
    { count: 7, isSeveral: true },
    { count: 2.5, isSeveral: false },
    { count: 1.5, isSeveral: false },
    { count: -2, isSeveral: false },
    { count: Number.NaN, isSeveral: false },
    { count: Number.POSITIVE_INFINITY, isSeveral: false },
];

const FIELDS = {
    visible: true,
    enabled: true,
    text: "Ready",
    value: null,
    sensitive: false,
    box: null,
};
const ONE_ELEMENT: ElementsRead = {
    ...FIELDS,
    count: 1,
    states: { selected: null, expanded: null, pressed: null, current: null },
    href: null,
};
const NO_ELEMENT: ElementsRead = { count: 0 };

describe("Using the check of several elements", () => {
    for (const { count, isSeveral } of COUNTS) {
        describe(`given a count of ${count}`, () => {
            describe("when the count is checked", () => {
                test(`then it should say ${isSeveral}`, () => {
                    assert.equal(isSeveralElements(count), isSeveral);
                });
            });
        });
    }
});

describe("Using the check of a read of one element", () => {
    describe("given a read of one element", () => {
        describe("when the read is checked", () => {
            test("then it should say so", () => {
                assert.equal(isOneElementRead(ONE_ELEMENT), true);
            });
        });
    });

    describe("given a read of no element", () => {
        describe("when the read is checked", () => {
            test("then it should say it is not", () => {
                assert.equal(isOneElementRead(NO_ELEMENT), false);
            });
        });
    });

    describe("given a read of several elements", () => {
        describe("when the read is checked", () => {
            test("then it should say it is not", () => {
                const count = 2;
                assert.ok(isSeveralElements(count));
                assert.equal(isOneElementRead({ ...FIELDS, count }), false);
            });
        });
    });
});
