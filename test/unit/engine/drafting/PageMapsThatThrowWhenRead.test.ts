// A page map comes back from the isolated runner, and the decoder promises an answer for every
// value it is handed, not just for what JSON.parse makes. A field whose getter throws or a proxy
// that throws is refused where it sits, as any value of the wrong form is, and never thrown.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodePageMap } from "@revisum/engine";
import {
    listWithoutPrototype,
    proxyThatThrows,
    revokedProxy,
    withThrowingGetter,
} from "#test-support/ProxyThatThrows.ts";
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

const withPages = (pages: unknown): JsonRecord => withValue(pageMap(), ["pages"], pages);
const withFirstPage = (page: unknown): JsonRecord => withValue(pageMap(), ["pages", 0], page);
const withTree = (tree: unknown): JsonRecord => withValue(pageMap(), ["pages", 0, "tree"], tree);
const withFirstNode = (node: unknown): JsonRecord =>
    withValue(pageMap(), ["pages", 0, "tree", 0], node);
const withChildren = (children: unknown): JsonRecord =>
    withValue(pageMap(), ["pages", 0, "tree", 0, "children"], children);

const HOSTILE_PAGE_MAPS: readonly {
    readonly name: string;
    readonly hostile: () => unknown;
    readonly path: string;
}[] = [
    {
        name: "a page map whose origin has a getter that throws",
        hostile: () => withThrowingGetter(pageMap(), "origin"),
        path: "$",
    },
    {
        name: "a proxy that throws on every read as the page map",
        hostile: () => proxyThatThrows(pageMap()),
        path: "$",
    },
    { name: "a revoked proxy as the page map", hostile: () => revokedProxy(pageMap()), path: "$" },
    {
        name: "the pages in a proxy over a list that throws on every read",
        hostile: () => withPages(proxyThatThrows([PAGE])),
        path: "$.pages",
    },
    {
        name: "the pages in a revoked proxy over a list",
        hostile: () => withPages(revokedProxy([PAGE])),
        path: "$.pages",
    },
    {
        name: "the pages in a list with no prototype",
        hostile: () => withPages(listWithoutPrototype([PAGE])),
        path: "$.pages",
    },
    {
        name: "a first page whose title has a getter that throws",
        hostile: () => withFirstPage(withThrowingGetter(PAGE, "title")),
        path: "$.pages[0]",
    },
    {
        name: "a first page that is a proxy throwing on every read",
        hostile: () => withFirstPage(proxyThatThrows({ ...PAGE })),
        path: "$.pages[0]",
    },
    {
        name: "a first page that is a revoked proxy",
        hostile: () => withFirstPage(revokedProxy({ ...PAGE })),
        path: "$.pages[0]",
    },
    {
        name: "a tree in a proxy over a list that throws on every read",
        hostile: () => withTree(proxyThatThrows([NODE])),
        path: "$.pages[0].tree",
    },
    {
        name: "a first node whose name has a getter that throws",
        hostile: () => withFirstNode(withThrowingGetter(NODE, "name")),
        path: "$.pages[0].tree[0]",
    },
    {
        name: "a node's children in a revoked proxy over a list",
        hostile: () => withChildren(revokedProxy([CHILD_NODE])),
        path: "$.pages[0].tree[0].children",
    },
];

describe("Using decodePageMap", () => {
    for (const { name, hostile, path } of HOSTILE_PAGE_MAPS) {
        describe(`given ${name}`, () => {
            describe("when it is decoded", () => {
                test(`then it should refuse it at ${path} without throwing`, () => {
                    const input = hostile();
                    let decoded: unknown;
                    assert.doesNotThrow(() => {
                        decoded = decodePageMap(input, origin);
                    });
                    assert.deepEqual(decoded, {
                        ok: false,
                        error: { code: "page-map-invalid", path },
                    });
                });
            });
        });
    }
});
