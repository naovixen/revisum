// A page map comes back from the isolated runner as JSON. Checking only its keys would let a class
// instance holding exactly the right fields through, so its prototype is checked too, at every level.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodePageMap } from "@revisum/engine";
import { classInstanceHolding } from "../../../support/ClassInstanceHolding.ts";
import { testProject, withValue, type JsonRecord } from "../plan/examples/GoldenPlan.ts";

const origin = testProject().origins[0];
assert.ok(origin !== undefined, "the test project declares no origin");

const CHILD_NODE = { role: "link", name: "Home", children: [] };
const NODE = { role: "navigation", name: "Main", children: [CHILD_NODE] };
const PAGE = { path: "/", title: "Home", depth: 0, tree: [NODE] };

const pageMap = (): JsonRecord => ({
    origin,
    pages: [PAGE],
    truncated: false,
    guaranteeLevel: "host",
});

const LEVELS: readonly {
    readonly name: string;
    readonly path: string;
    readonly replace: (value: unknown) => unknown;
    readonly holding: object;
}[] = [
    { name: "the map", path: "$", replace: (value) => value, holding: pageMap() },
    {
        name: "a page",
        path: "$.pages[0]",
        replace: (value) => withValue(pageMap(), ["pages", 0], value),
        holding: PAGE,
    },
    {
        name: "a node",
        path: "$.pages[0].tree[0]",
        replace: (value) => withValue(pageMap(), ["pages", 0, "tree", 0], value),
        holding: NODE,
    },
    {
        name: "a node's child",
        path: "$.pages[0].tree[0].children[0]",
        replace: (value) => withValue(pageMap(), ["pages", 0, "tree", 0, "children", 0], value),
        holding: CHILD_NODE,
    },
];

const refusedAt = (path: string): unknown => ({
    ok: false,
    error: { code: "page-map-invalid", path },
});

describe("Using decodePageMap", () => {
    describe("given a page map as JSON writes it", () => {
        describe("when it is decoded", () => {
            test("then it should give the map", () => {
                assert.deepEqual(decodePageMap(pageMap(), origin), {
                    ok: true,
                    value: pageMap(),
                });
            });
        });
    });

    for (const { name, path, replace, holding } of LEVELS) {
        describe(`given a class instance holding exactly the fields of ${name}`, () => {
            describe("when it is decoded", () => {
                test("then it should refuse it at its path", () => {
                    const input = replace(classInstanceHolding(holding));
                    assert.deepEqual(decodePageMap(input, origin), refusedAt(path));
                });
            });
        });

        describe(`given a Date in place of ${name}`, () => {
            describe("when it is decoded", () => {
                test("then it should refuse it at its path", () => {
                    assert.deepEqual(decodePageMap(replace(new Date(0)), origin), refusedAt(path));
                });
            });
        });
    }
});
