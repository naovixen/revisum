// readFields reads an object against a table of field readers. It stands between outside input and
// everything after it, so what a caller may rely on is checked here: nothing but the table's fields
// comes through, every problem is reported where it sits and in a fixed order, a key shaped like a
// credential is never repeated, and INVALID always comes with something to show a person.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    INVALID,
    optionalField,
    readFields,
    readInteger,
    type FieldReader,
    type Issues,
    type Parsed,
} from "@revisum/engine";
import { tokenShapedText } from "../../evidence/examples/EvidenceRun.ts";

const OLDEST_AGE = 150;

const readName: FieldReader<string> = (input, path, issues) => {
    if (typeof input === "string") {
        return input;
    }
    issues.push({ code: "wrong_type", path });
    return INVALID;
};
const readAge: FieldReader<number> = (input, path, issues) =>
    readInteger(input, path, issues, 0, OLDEST_AGE);
const readAnything: FieldReader<unknown> = (input) => input;
const readNothing: FieldReader<string> = () => INVALID;

const PERSON = { name: readName, age: optionalField(readAge) };

const issuesAfterReading = (input: unknown): Issues => {
    const issues: Issues = [];
    readFields(input, "$", issues, PERSON);
    return issues;
};

function valid<Value>(parsed: Parsed<Value>): Value {
    if (parsed === INVALID) {
        assert.fail("the input was refused");
    }
    return parsed;
}

const NOT_PLAIN_OBJECTS: readonly { readonly name: string; readonly value: unknown }[] = [
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "a string", value: "Ada" },
    { name: "a number", value: 36 },
    { name: "a list", value: [{ name: "Ada" }] },
    { name: "a Date", value: new Date(0) },
    { name: "a Map", value: new Map([["name", "Ada"]]) },
    { name: "an object inheriting its fields", value: Object.create({ name: "Ada" }) },
];

describe("Using readFields", () => {
    describe("given a table of required and optional fields", () => {
        describe("when its result is used", () => {
            test("then it should type a required field by its reader and an optional one as possibly absent", () => {
                const person = valid(readFields({ name: "Ada" }, "$", [], PERSON));
                const name: string = person.name;
                const age: number | undefined = person.age;
                assert.deepEqual({ name, age }, { name: "Ada", age: undefined });
            });

            test("then it should not compile an optional field read as always there", () => {
                const person = valid(readFields({ name: "Ada" }, "$", [], PERSON));
                // @ts-expect-error An optional field may be absent.
                const age: number = person.age;
                assert.equal(age, undefined);
            });

            test("then it should not compile a field read as the wrong type", () => {
                const person = valid(readFields({ name: "Ada" }, "$", [], PERSON));
                // @ts-expect-error The name's reader gives text.
                const name: number = person.name;
                assert.equal(name, "Ada");
            });

            test("then it should not compile a field the table does not name", () => {
                const person = valid(readFields({ name: "Ada" }, "$", [], PERSON));
                // @ts-expect-error The table has no such field.
                assert.equal(person.nickname, undefined);
            });
        });
    });

    describe("given a table with an entry that is no reader", () => {
        describe("when it is passed", () => {
            test("then it should not compile", () => {
                // @ts-expect-error A table holds field readers only.
                const parsed = readFields({}, "$", [], { name: "text" });
                assert.deepEqual(parsed, {});
            });
        });
    });

    for (const { name, value } of NOT_PLAIN_OBJECTS) {
        describe(`given ${name}`, () => {
            describe("when it is read", () => {
                test("then it should report not_object at the path and read no field", (context) => {
                    const reader = context.mock.fn(readName);
                    const issues: Issues = [];
                    const parsed = readFields(value, "$.person", issues, { name: reader });
                    assert.equal(parsed, INVALID);
                    assert.deepEqual(issues, [{ code: "not_object", path: "$.person" }]);
                    assert.equal(reader.mock.callCount(), 0);
                });
            });
        });
    }

    describe("given an object with no prototype holding the fields", () => {
        describe("when it is read", () => {
            test("then it should give the fields", () => {
                const person: unknown = Object.assign(Object.create(null), { name: "Ada" });
                assert.deepEqual(
                    { ...valid(readFields(person, "$", [], PERSON)) },
                    { name: "Ada" },
                );
            });
        });
    });

    describe("given a field the table does not name", () => {
        describe("when it is read", () => {
            test("then it should report unknown_field at that field and read no field", (context) => {
                const reader = context.mock.fn(readName);
                const issues: Issues = [];
                const parsed = readFields({ name: "Ada", nickname: "A" }, "$.person", issues, {
                    name: reader,
                });
                assert.equal(parsed, INVALID);
                assert.deepEqual(issues, [{ code: "unknown_field", path: "$.person.nickname" }]);
                assert.equal(reader.mock.callCount(), 0);
            });
        });
    });

    describe("given a required field left out", () => {
        describe("when it is read", () => {
            test("then it should report missing_field at that field and read no field", (context) => {
                const reader = context.mock.fn(readAge);
                const issues: Issues = [];
                const parsed = readFields({ age: 36 }, "$", issues, {
                    name: readName,
                    age: reader,
                });
                assert.equal(parsed, INVALID);
                assert.deepEqual(issues, [{ code: "missing_field", path: "$.name" }]);
                assert.equal(reader.mock.callCount(), 0);
            });
        });
    });

    describe("given a key shaped like a credential", () => {
        describe("when it is read", () => {
            test("then it should report literal_secret at the object, not at the key", () => {
                const issues = issuesAfterReading({ name: "Ada", [tokenShapedText()]: "yes" });
                assert.deepEqual(issues, [{ code: "literal_secret", path: "$" }]);
            });

            test("then it should keep nothing of the key in what it reports", () => {
                const token = tokenShapedText();
                const issues = issuesAfterReading({ name: "Ada", [token]: "yes" });
                assert.equal(JSON.stringify(issues).includes(token), false);
            });
        });
    });

    describe("given several faults in the object itself", () => {
        describe("when it is read", () => {
            test("then it should report the extra keys as written, then the missing fields in the table's order", () => {
                const issues: Issues = [];
                readFields({ zebra: 1, apple: 2 }, "$", issues, {
                    second: readName,
                    first: readName,
                });
                assert.deepEqual(issues, [
                    { code: "unknown_field", path: "$.zebra" },
                    { code: "unknown_field", path: "$.apple" },
                    { code: "missing_field", path: "$.second" },
                    { code: "missing_field", path: "$.first" },
                ]);
            });
        });
    });

    describe("given several fields with bad values, written in another order than the table's", () => {
        describe("when it is read", () => {
            test("then it should report every field, in the table's order, under its path", () => {
                const issues: Issues = [];
                const input = { third: "old", second: "old", first: 1 };
                const parsed = readFields(input, "$.person", issues, {
                    first: readName,
                    second: readAge,
                    third: optionalField(readAge),
                });
                assert.equal(parsed, INVALID);
                assert.deepEqual(issues, [
                    { code: "wrong_type", path: "$.person.first" },
                    { code: "wrong_type", path: "$.person.second" },
                    { code: "wrong_type", path: "$.person.third" },
                ]);
            });
        });
    });

    describe("given a valid object written in another order than the table's", () => {
        describe("when it is read", () => {
            test("then it should give the fields in the table's order", () => {
                const parsed = readFields({ age: 36, name: "Ada" }, "$", [], PERSON);
                assert.equal(JSON.stringify(valid(parsed)), '{"name":"Ada","age":36}');
            });

            test("then it should keep a field whose value is falsy", () => {
                const parsed = readFields({ name: "Ada", age: 0 }, "$", [], PERSON);
                assert.deepEqual(valid(parsed), { name: "Ada", age: 0 });
            });
        });

        describe("and issues already reported about something else", () => {
            describe("when it is read", () => {
                test("then it should still give the fields and leave those issues alone", () => {
                    const earlier = { code: "empty", path: "$.earlier" } as const;
                    const issues: Issues = [earlier];
                    const parsed = readFields({ name: "Ada" }, "$", issues, PERSON);
                    assert.deepEqual(valid(parsed), { name: "Ada" });
                    assert.deepEqual(issues, [earlier]);
                });
            });
        });
    });

    describe("given a field reader", () => {
        describe("when a field is read", () => {
            test("then it should hand the reader the value, the field's path and the issues", (context) => {
                const reader = context.mock.fn(readName);
                const issues: Issues = [];
                readFields({ name: "Ada" }, "$.person", issues, { name: reader });
                assert.equal(reader.mock.callCount(), 1);
                assert.deepEqual(reader.mock.calls[0]?.arguments.slice(0, 2), [
                    "Ada",
                    "$.person.name",
                ]);
                assert.equal(reader.mock.calls[0].arguments[2], issues);
            });
        });
    });

    describe("given an optional field left out", () => {
        describe("when it is read", () => {
            test("then it should leave the field out of the result, not hold it as undefined", () => {
                const person = valid(readFields({ name: "Ada" }, "$", [], PERSON));
                assert.deepEqual(Object.keys(person), ["name"]);
            });

            test("then it should not call the field's reader", (context) => {
                const reader = context.mock.fn(readAge);
                const parsed = readFields({}, "$", [], { age: optionalField(reader) });
                assert.deepEqual(valid(parsed), {});
                assert.equal(reader.mock.callCount(), 0);
            });
        });
    });

    describe("given an optional field present and holding undefined", () => {
        describe("when it is read", () => {
            test("then it should have the reader judge it, not treat it as left out", () => {
                const issues = issuesAfterReading({ name: "Ada", age: undefined });
                assert.deepEqual(issues, [{ code: "wrong_type", path: "$.age" }]);
            });
        });
    });

    describe("given a required field holding undefined, and a reader that accepts it", () => {
        describe("when it is read", () => {
            test("then it should keep the field in the result", () => {
                const parsed = readFields({ note: undefined }, "$", [], { note: readAnything });
                assert.deepEqual(Object.keys(valid(parsed)), ["note"]);
            });
        });
    });

    describe("given a field named like something every object inherits", () => {
        describe("and required in the table but left out", () => {
            describe("when it is read", () => {
                test("then it should report missing_field, not read the inherited value", () => {
                    const issues: Issues = [];
                    readFields({}, "$", issues, { constructor: readAnything });
                    assert.deepEqual(issues, [{ code: "missing_field", path: "$.constructor" }]);
                });
            });
        });

        describe("and optional in the table but left out", () => {
            describe("when it is read", () => {
                test("then it should leave the field out, not read the inherited value", (context) => {
                    const reader = context.mock.fn(readAnything);
                    const parsed = readFields({}, "$", [], { toString: optionalField(reader) });
                    assert.deepEqual(Object.keys(valid(parsed)), []);
                    assert.equal(reader.mock.callCount(), 0);
                });
            });
        });
    });

    describe("given an own __proto__ key, as JSON.parse makes one", () => {
        const withPrototypeKey: unknown = JSON.parse('{"name":"Ada","__proto__":{"isAdmin":true}}');

        describe("and a table that does not name it", () => {
            describe("when it is read", () => {
                test("then it should report it as unknown_field and give no result", () => {
                    const issues: Issues = [];
                    const parsed = readFields(withPrototypeKey, "$", issues, PERSON);
                    assert.equal(parsed, INVALID);
                    assert.deepEqual(issues, [{ code: "unknown_field", path: "$.__proto__" }]);
                });
            });
        });

        describe("and a table that names it", () => {
            describe("when it is read", () => {
                const readWithPrototypeKey = (): object =>
                    valid(
                        readFields(withPrototypeKey, "$", [], {
                            name: readName,
                            ["__proto__"]: readAnything,
                        }),
                    );

                test("then it should keep it as an own field", () => {
                    const field = Object.getOwnPropertyDescriptor(
                        readWithPrototypeKey(),
                        "__proto__",
                    );
                    assert.deepEqual(field?.value, { isAdmin: true });
                });

                test("then it should not change the result's prototype", () => {
                    assert.equal(Object.getPrototypeOf(readWithPrototypeKey()), Object.prototype);
                });
            });
        });
    });

    describe("given a reader that reports an issue but still gives a value", () => {
        describe("when it is read", () => {
            test("then it should give INVALID, not a result holding that value", () => {
                const issues: Issues = [];
                const parsed = readFields({ name: "Ada" }, "$", issues, {
                    name: (input: unknown, path: string, readerIssues: Issues) => {
                        readerIssues.push({ code: "unknown_value", path });
                        return input;
                    },
                });
                assert.equal(parsed, INVALID);
                assert.deepEqual(issues, [{ code: "unknown_value", path: "$.name" }]);
            });
        });
    });

    // A caller ends a parse with failure(issues), and a parser deciding by the issues alone would
    // call the input valid. So INVALID has to come with something saying which field it was about.
    describe("given a reader that gives INVALID and reports no issue", () => {
        for (const { kind, table } of [
            { kind: "required", table: { name: readNothing } },
            { kind: "optional", table: { name: optionalField(readNothing) } },
        ]) {
            describe(`and the field ${kind}`, () => {
                describe("when it is read", () => {
                    test("then it should give INVALID, not a result holding the marker", () => {
                        assert.equal(readFields({ name: "Ada" }, "$", [], table), INVALID);
                    });

                    test("then it should report an issue at that field", () => {
                        const issues: Issues = [];
                        readFields({ name: "Ada" }, "$", issues, table);
                        assert.deepEqual(
                            issues.map((issue) => issue.path),
                            ["$.name"],
                        );
                    });
                });
            });
        }

        describe("and a later field with a bad value", () => {
            describe("when it is read", () => {
                test("then it should still report the later field", () => {
                    const issues: Issues = [];
                    readFields({ name: "Ada", age: "old" }, "$", issues, {
                        name: readNothing,
                        age: readAge,
                    });
                    assert.ok(
                        issues.some(
                            (issue) => issue.code === "wrong_type" && issue.path === "$.age",
                        ),
                        JSON.stringify(issues),
                    );
                });
            });
        });
    });
});
