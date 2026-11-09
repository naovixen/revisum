// In an object literal `__proto__: reader` sets the table's prototype instead of a key, yet its type
// still names a field, so readFields has to read it as the same field the computed form names. The
// input's prototype is checked as well, so a class instance holding the right fields is no record.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { INVALID, type Issues, type Parsed } from "@revisum/engine";
import {
    optionalField,
    readFields,
    type FieldReader,
} from "../../../../../packages/engine/src/plan/ReadFields.ts";
import { classInstanceHolding } from "../../../../support/ClassInstanceHolding.ts";
import { PlanErrorCode } from "@revisum/contracts";

const readName: FieldReader<string> = (input, path, issues) => {
    if (typeof input === "string") {
        return input;
    }
    issues.push({ code: PlanErrorCode.WrongType, path });
    return INVALID;
};
const readAnything: FieldReader<unknown> = (input) => input;

const tableWithPrototypeKey = () => ({ name: readName, __proto__: readAnything });

function valid<Value>(parsed: Parsed<Value>): Value {
    if (parsed === INVALID) {
        assert.fail("the input was refused");
    }
    return parsed;
}

describe("Using readFields", () => {
    describe("given a table written with a literal __proto__ key", () => {
        describe("and an input without the field", () => {
            describe("when it is read", () => {
                test("then it should report missing_field at that field", () => {
                    const issues: Issues = [];
                    const parsed = readFields(
                        { name: "Ada" },
                        "$",
                        issues,
                        tableWithPrototypeKey(),
                    );
                    assert.equal(parsed, INVALID);
                    assert.deepEqual(issues, [{ code: "missing_field", path: "$.__proto__" }]);
                });
            });
        });

        describe("and an input holding the field as its first key", () => {
            const readPerson = (): object =>
                valid(
                    readFields(
                        JSON.parse('{"__proto__":{"isAdmin":true},"name":"Ada"}'),
                        "$",
                        [],
                        tableWithPrototypeKey(),
                    ),
                );

            describe("when it is read", () => {
                test("then it should keep it as an own field", () => {
                    const field = Object.getOwnPropertyDescriptor(readPerson(), "__proto__");
                    assert.deepEqual(field?.value, { isAdmin: true });
                });

                test("then it should give that field last", () => {
                    assert.deepEqual(Object.keys(readPerson()), ["name", "__proto__"]);
                });

                test("then it should not change the result's prototype", () => {
                    assert.equal(Object.getPrototypeOf(readPerson()), Object.prototype);
                });
            });
        });

        describe("and the field in the optional form", () => {
            describe("and an input without the field", () => {
                describe("when it is read", () => {
                    test("then it should leave the field out and not call its reader", (context) => {
                        const reader = context.mock.fn(readAnything);
                        const person = valid(
                            readFields({ name: "Ada" }, "$", [], {
                                name: readName,
                                __proto__: optionalField(reader),
                            }),
                        );
                        assert.deepEqual(Object.keys(person), ["name"]);
                        assert.equal(Object.hasOwn(person, "__proto__"), false);
                        assert.equal(reader.mock.callCount(), 0);
                    });
                });
            });

            describe("and an input holding the field", () => {
                describe("when it is read", () => {
                    test("then it should keep it as an own field, read by its reader", () => {
                        const person = valid(
                            readFields(
                                JSON.parse('{"name":"Ada","__proto__":{"isAdmin":true}}'),
                                "$",
                                [],
                                { name: readName, __proto__: optionalField(readAnything) },
                            ),
                        );
                        const field = Object.getOwnPropertyDescriptor(person, "__proto__");
                        assert.deepEqual(field?.value, { isAdmin: true });
                        assert.equal(Object.getPrototypeOf(person), Object.prototype);
                    });
                });
            });
        });
    });

    describe("given a class instance holding exactly the table's fields", () => {
        describe("when it is read", () => {
            test("then it should report not_object at the path and read no field", (context) => {
                const reader = context.mock.fn(readName);
                const issues: Issues = [];
                const parsed = readFields(classInstanceHolding({ name: "Ada" }), "$", issues, {
                    name: reader,
                });
                assert.equal(parsed, INVALID);
                assert.deepEqual(issues, [{ code: "not_object", path: "$" }]);
                assert.equal(reader.mock.callCount(), 0);
            });
        });
    });
});
