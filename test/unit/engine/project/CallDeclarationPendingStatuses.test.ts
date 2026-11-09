// A call declaration may list pendingStatuses, optionally. The project parser reads them the way it
// reads successStatuses, and reports a refusal by code and path alone, never by the value it refused.
// A status may not be in both lists, and a write declaration may not list any: a backend check, the
// only reader of the field, repeats its call, so it only ever runs a read.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseProject, type Project } from "@revisum/engine";
import {
    CALLS,
    callProject,
    callProjectFile,
    declarationOf,
    type JsonRecord,
} from "../run/executors/service-calls/examples/ShopService.ts";

const PENDING_PATH = "$.calls.getOrder.pendingStatuses";
const SUCCESS_PATH = "$.calls.getOrder.successStatuses";
const LARGEST_LIST_LENGTH = 32;

const statusesFrom201 = (count: number): readonly number[] =>
    [...Array(count).keys()].map((index) => 201 + index);

const getOrderWith = (changes: JsonRecord): JsonRecord => ({
    ...(structuredClone(CALLS["getOrder"]) as JsonRecord),
    ...changes,
});

const pendingStatusesOf = (project: Project): unknown => {
    const fields: Readonly<Record<string, unknown>> = declarationOf(project, "getOrder");
    return fields["pendingStatuses"];
};

const refusalOf = (changes: JsonRecord): unknown => {
    const parsed = parseProject(callProjectFile({ getOrder: getOrderWith(changes) }));
    assert.ok(!parsed.ok, "the project was accepted");
    return parsed.error;
};

// The one error a refused project reports, checked to hold its code and path and nothing else.
const onlyErrorOf = (calls: JsonRecord): { readonly code: string; readonly path: string } => {
    const parsed = parseProject(callProjectFile(calls));
    assert.ok(!parsed.ok, "the project was accepted");
    const [error] = parsed.error;
    assert.ok(error !== undefined && parsed.error.length === 1, JSON.stringify(parsed.error));
    assert.deepEqual(Object.keys(error).toSorted(), ["code", "path"]);
    assert.notEqual(error.code, "unknown_field", "pendingStatuses is a field the format has");
    return error;
};

const STATUSES_IN_BOTH_LISTS: readonly {
    readonly name: string;
    readonly successStatuses: readonly number[];
    readonly pendingStatuses: readonly number[];
}[] = [
    { name: "the only status of each", successStatuses: [200], pendingStatuses: [200] },
    { name: "one of several", successStatuses: [200, 404], pendingStatuses: [202, 404] },
    { name: "a gateway status", successStatuses: [200, 503], pendingStatuses: [503] },
];

const ACCEPTED_LISTS: readonly { readonly name: string; readonly statuses: readonly number[] }[] = [
    { name: "one status", statuses: [404] },
    { name: "two statuses, kept in the order written", statuses: [404, 202] },
    { name: "the lowest and highest statuses", statuses: [100, 599] },
    {
        name: "as many statuses as the list may hold",
        statuses: statusesFrom201(LARGEST_LIST_LENGTH),
    },
];

const REFUSED_VALUES: readonly {
    readonly name: string;
    readonly value: unknown;
    readonly code: string;
    readonly at: string;
}[] = [
    { name: "a number, not a list", value: 404, code: "wrong_type", at: "" },
    { name: "text, not a list", value: "404", code: "wrong_type", at: "" },
    { name: "an object, not a list", value: { status: 404 }, code: "wrong_type", at: "" },
    { name: "null", value: null, code: "wrong_type", at: "" },
    { name: "an empty list", value: [], code: "empty", at: "" },
    {
        name: "a list longer than it may be",
        value: statusesFrom201(LARGEST_LIST_LENGTH + 1),
        code: "too_large",
        at: "",
    },
    { name: "a status written as text", value: [202, "404"], code: "wrong_type", at: "[1]" },
    { name: "a status that is not whole", value: [404.5], code: "wrong_type", at: "[0]" },
    { name: "a status that is null", value: [null], code: "wrong_type", at: "[0]" },
    { name: "a status below 100", value: [99], code: "unknown_value", at: "[0]" },
    { name: "a status above 599", value: [202, 600], code: "unknown_value", at: "[1]" },
    { name: "a status listed twice", value: [404, 202, 404], code: "duplicate", at: "" },
];

describe("Using the project parser", () => {
    describe("given a call declaration that lists pendingStatuses", () => {
        for (const accepted of ACCEPTED_LISTS) {
            describe(`and the list holds ${accepted.name}`, () => {
                describe("when the project is parsed", () => {
                    test("then it should keep the statuses as written", () => {
                        const project = callProject({
                            getOrder: getOrderWith({ pendingStatuses: accepted.statuses }),
                        });
                        assert.deepEqual(pendingStatusesOf(project), accepted.statuses);
                    });

                    test("then it should leave the success statuses as they were", () => {
                        const project = callProject({
                            getOrder: getOrderWith({ pendingStatuses: accepted.statuses }),
                        });
                        assert.deepEqual(declarationOf(project, "getOrder").successStatuses, [200]);
                    });
                });
            });
        }

        for (const refused of REFUSED_VALUES) {
            describe(`and the field holds ${refused.name}`, () => {
                describe("when the project is parsed", () => {
                    test(`then it should refuse it with ${refused.code} at the field, and report nothing else`, () => {
                        assert.deepEqual(refusalOf({ pendingStatuses: refused.value }), [
                            { code: refused.code, path: `${PENDING_PATH}${refused.at}` },
                        ]);
                    });
                });

                describe("when the same value is given as successStatuses", () => {
                    test(`then it should refuse that with ${refused.code} too`, () => {
                        assert.deepEqual(refusalOf({ successStatuses: refused.value }), [
                            { code: refused.code, path: `${SUCCESS_PATH}${refused.at}` },
                        ]);
                    });
                });
            });
        }
    });

    for (const overlap of STATUSES_IN_BOTH_LISTS) {
        describe(`given a read declaration whose two status lists share ${overlap.name}`, () => {
            describe("when the project is parsed", () => {
                test("then it should refuse it, reporting a code and a path on pendingStatuses only", () => {
                    const { path } = onlyErrorOf({
                        getOrder: getOrderWith({
                            successStatuses: overlap.successStatuses,
                            pendingStatuses: overlap.pendingStatuses,
                        }),
                    });
                    assert.ok(
                        path === PENDING_PATH || path.startsWith(`${PENDING_PATH}[`),
                        `${path} is not on pendingStatuses`,
                    );
                });
            });
        });
    }

    describe("given a read declaration whose two status lists share nothing, one listing a gateway status", () => {
        describe("when the project is parsed", () => {
            test("then it should keep both lists", () => {
                const project = callProject({
                    getOrder: getOrderWith({ successStatuses: [200, 502], pendingStatuses: [503] }),
                });
                assert.deepEqual(declarationOf(project, "getOrder").successStatuses, [200, 502]);
                assert.deepEqual(pendingStatusesOf(project), [503]);
            });
        });
    });

    describe("given a write declaration that lists pendingStatuses", () => {
        describe("when the project is parsed", () => {
            test("then it should refuse it, reporting a code and a path in that declaration only", () => {
                const { path } = onlyErrorOf({
                    createOrder: {
                        ...(structuredClone(CALLS["createOrder"]) as JsonRecord),
                        pendingStatuses: [202],
                    },
                });
                assert.ok(path.startsWith("$.calls.createOrder."), path);
            });
        });
    });

    describe("given a write declaration that does not list pendingStatuses", () => {
        describe("when the project is parsed", () => {
            test("then it should accept it", () => {
                assert.equal(declarationOf(callProject(), "createOrder").effect, "write");
            });
        });
    });

    describe("given a call declaration that does not list pendingStatuses", () => {
        describe("when the project is parsed", () => {
            test("then it should leave the field out of the declaration", () => {
                const declaration = declarationOf(callProject(), "getOrder");
                assert.equal(Object.hasOwn(declaration, "pendingStatuses"), false);
            });
        });
    });
});
