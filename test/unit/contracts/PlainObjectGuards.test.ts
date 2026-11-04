// Two guards name two questions about a value. isNonArrayObject asks only "is this an object that
// is not a list?", so a Date passes it; isPlainObject asks "could an object literal or JSON have
// made this?", so a value's inherited behaviour can't be read as if it were fields.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isNonArrayObject, isPlainObject } from "@revisum/contracts";

class Invoice {
    readonly total = 3;
}

const VALUES: readonly {
    readonly name: string;
    readonly value: unknown;
    readonly isObjectButNotAList: boolean;
    readonly isPlain: boolean;
}[] = [
    { name: "an empty object", value: {}, isObjectButNotAList: true, isPlain: true },
    {
        name: "an object with a field",
        value: { total: 3 },
        isObjectButNotAList: true,
        isPlain: true,
    },
    {
        name: "an object with no prototype",
        value: Object.create(null),
        isObjectButNotAList: true,
        isPlain: true,
    },
    {
        name: "an object JSON made with an own __proto__ key",
        value: JSON.parse('{"__proto__":{"total":3}}'),
        isObjectButNotAList: true,
        isPlain: true,
    },
    { name: "an empty list", value: [], isObjectButNotAList: false, isPlain: false },
    { name: "a list with an item", value: [1], isObjectButNotAList: false, isPlain: false },
    {
        name: "a list with no prototype",
        value: Object.setPrototypeOf([], null),
        isObjectButNotAList: false,
        isPlain: false,
    },
    { name: "null", value: null, isObjectButNotAList: false, isPlain: false },
    { name: "undefined", value: undefined, isObjectButNotAList: false, isPlain: false },
    { name: "a string", value: "text", isObjectButNotAList: false, isPlain: false },
    { name: "a number", value: 3, isObjectButNotAList: false, isPlain: false },
    { name: "a boolean", value: true, isObjectButNotAList: false, isPlain: false },
    { name: "a function", value: () => 3, isObjectButNotAList: false, isPlain: false },
    { name: "a Date", value: new Date(0), isObjectButNotAList: true, isPlain: false },
    { name: "a Map", value: new Map(), isObjectButNotAList: true, isPlain: false },
    { name: "a class instance", value: new Invoice(), isObjectButNotAList: true, isPlain: false },
    {
        name: "an object inheriting from another object",
        value: Object.create({ total: 3 }),
        isObjectButNotAList: true,
        isPlain: false,
    },
];

describe("Using the plain object guards", () => {
    for (const { name, value, isObjectButNotAList, isPlain } of VALUES) {
        describe(`given ${name}`, () => {
            describe("when isNonArrayObject reads it", () => {
                test(`then it should answer ${isObjectButNotAList}`, () => {
                    assert.equal(isNonArrayObject(value), isObjectButNotAList);
                });
            });

            describe("when isPlainObject reads it", () => {
                test(`then it should answer ${isPlain}`, () => {
                    assert.equal(isPlainObject(value), isPlain);
                });
            });
        });
    }
});
