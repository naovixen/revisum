// Report data comes from JSON files. Its parsers read fields off objects, so a class instance holding
// exactly the right fields is refused as not_object wherever it sits: its inherited behaviour is not
// data, and a report built from it could not be written back the same.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseHistory, parseReportInput } from "@revisum/report";
import { classInstanceHolding } from "../../support/ClassInstanceHolding.ts";
import { REPORT_INPUTS } from "../../support/report-fixtures.ts";

type Segments = readonly (string | number)[];

const readInput = (name: string): object => {
    const parsed: unknown = JSON.parse(readFileSync(join(REPORT_INPUTS, `${name}.json`), "utf8"));
    assert.ok(typeof parsed === "object" && parsed !== null);
    return parsed;
};

const asPath = (segments: Segments): string =>
    segments.reduce<string>(
        (path, segment) =>
            typeof segment === "number" ? `${path}[${segment}]` : `${path}.${segment}`,
        "$",
    );

const valueAt = (input: object, segments: Segments): object => {
    const found = segments.reduce<unknown>(
        (holder, segment) => Reflect.get(Object(holder), segment),
        input,
    );
    assert.ok(typeof found === "object" && found !== null, `nothing at ${asPath(segments)}`);
    return found;
};

const withFieldsInAClassInstanceAt = (input: object, segments: Segments): object => {
    const copy = structuredClone(input);
    const holder = valueAt(copy, segments.slice(0, -1));
    const last = segments.at(-1);
    assert.ok(last !== undefined);
    Reflect.set(holder, last, classInstanceHolding(valueAt(copy, segments)));
    return copy;
};

const NESTED_REPORT_OBJECTS: readonly { readonly input: string; readonly at: Segments }[] = [
    { input: "functional", at: ["images", 0] },
    { input: "functional", at: ["steps", 0] },
    { input: "functional", at: ["findings", 0] },
    { input: "functional", at: ["findings", 0, "image"] },
    { input: "functional", at: ["findings", 0, "image", "box"] },
    { input: "functional", at: ["findings", 0, "criterion"] },
    { input: "functional", at: ["acceptance", 0] },
    { input: "functional", at: ["acceptance", 0, "evidence", 0] },
    { input: "functional", at: ["run"] },
    { input: "functional", at: ["run", "inputs", 0] },
    { input: "api", at: ["findings", 0, "exchanges", 0] },
];

const NESTED_HISTORY_OBJECTS: readonly Segments[] = [
    ["periods", 0],
    ["periods", 0, "escaped"],
];

const NOT_OBJECT_AT_THE_TOP = {
    ok: false,
    error: [{ path: "$", code: "not_object" }],
};

describe("Using the report data parsers", () => {
    describe("given an object that inherits a whole valid report", () => {
        describe("when parseReportInput reads it", () => {
            test("then it should refuse it as not_object at the top", () => {
                const inheriting: unknown = Object.create(readInput("functional"));
                assert.deepEqual(parseReportInput(inheriting), NOT_OBJECT_AT_THE_TOP);
            });
        });
    });

    describe("given a class instance holding exactly a valid report's fields", () => {
        describe("when parseReportInput reads it", () => {
            test("then it should refuse it as not_object at the top", () => {
                const instance = classInstanceHolding(readInput("functional"));
                assert.deepEqual(parseReportInput(instance), NOT_OBJECT_AT_THE_TOP);
            });
        });
    });

    describe("given a valid report in an object with no prototype", () => {
        describe("when parseReportInput reads it", () => {
            test("then it should accept it", () => {
                const report: unknown = Object.assign(Object.create(null), readInput("functional"));
                assert.equal(parseReportInput(report).ok, true);
            });
        });
    });

    for (const { input, at } of NESTED_REPORT_OBJECTS) {
        const path = asPath(at);

        describe(`given a class instance holding exactly the fields at ${path} of the ${input} report`, () => {
            describe("when parseReportInput reads it", () => {
                test("then it should report not_object at that path", () => {
                    const parsed = parseReportInput(
                        withFieldsInAClassInstanceAt(readInput(input), at),
                    );
                    assert.ok(!parsed.ok, "the report was accepted");
                    assert.ok(
                        parsed.error.some(
                            (error) => error.code === "not_object" && error.path === path,
                        ),
                        JSON.stringify(parsed.error.slice(0, 5)),
                    );
                });
            });
        });
    }

    describe("given a Date as the history", () => {
        describe("when parseHistory reads it", () => {
            test("then it should refuse it as not_object at the top", () => {
                assert.deepEqual(parseHistory(new Date(0)), NOT_OBJECT_AT_THE_TOP);
            });
        });
    });

    describe("given a class instance holding exactly a valid history's fields", () => {
        describe("when parseHistory reads it", () => {
            test("then it should refuse it as not_object at the top", () => {
                const instance = classInstanceHolding(readInput("history"));
                assert.deepEqual(parseHistory(instance), NOT_OBJECT_AT_THE_TOP);
            });
        });
    });

    for (const at of NESTED_HISTORY_OBJECTS) {
        const path = asPath(at);

        describe(`given a class instance holding exactly the fields at ${path} of the history`, () => {
            describe("when parseHistory reads it", () => {
                test("then it should report not_object at that path", () => {
                    const parsed = parseHistory(
                        withFieldsInAClassInstanceAt(readInput("history"), at),
                    );
                    assert.ok(!parsed.ok, "the history was accepted");
                    assert.ok(
                        parsed.error.some(
                            (error) => error.code === "not_object" && error.path === path,
                        ),
                        JSON.stringify(parsed.error.slice(0, 5)),
                    );
                });
            });
        });
    }
});
