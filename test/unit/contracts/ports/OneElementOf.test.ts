// The one place that tells the cases of a probe apart: the one element it read, or the code a check of
// that element fails with.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    failure,
    oneElementOf,
    success,
    UnreadablePage,
    type ElementProbe,
    type OneElementRead,
} from "@revisum/contracts";

const ONE_ELEMENT: OneElementRead = {
    count: 1,
    visible: false,
    enabled: false,
    text: "",
    value: null,
    sensitive: false,
    box: null,
    states: { selected: null, expanded: null, pressed: null, current: null },
    href: null,
};

const NO_ONE_ELEMENT: readonly {
    readonly name: string;
    readonly probe: ElementProbe;
    readonly code: string;
}[] = [
    { name: "no element", probe: { count: 0 }, code: "not-found" },
    {
        name: "a selector the browser rejects",
        probe: { count: "selector-invalid" },
        code: "selector-invalid",
    },
    ...Object.values(UnreadablePage).map((count) => ({
        name: `a page that gives ${count}`,
        probe: { count },
        code: count,
    })),
];

describe("Using the narrowing of a probe to its one element", () => {
    describe("given a read of one element", () => {
        describe("when it is narrowed", () => {
            test("then it should give that read, even of an element with nothing to show", () => {
                assert.deepEqual(oneElementOf(ONE_ELEMENT), success(ONE_ELEMENT));
            });
        });
    });

    for (const { name, probe, code } of NO_ONE_ELEMENT) {
        describe(`given a read of ${name}`, () => {
            describe("when it is narrowed", () => {
                test(`then it should give ${code}`, () => {
                    assert.deepEqual(oneElementOf(probe), failure(code));
                });
            });
        });
    }
});
