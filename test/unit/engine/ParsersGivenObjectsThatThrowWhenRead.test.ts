// A parser's input is unknown, and it promises a result for every value of that type, not just for
// what JSON.parse returns. A list with no prototype, a field whose getter throws and a proxy whose
// every trap throws can't come from JSON, but they can reach a parser in memory. Each is refused
// with the code the parser gives any value of the wrong form at that place, and never thrown.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    decodeManifest,
    parseProject,
    readFields,
    readInteger,
    readText,
    type FieldReader,
    type Issues,
} from "@revisum/engine";
import {
    accountClosurePlan,
    defaultParser,
    stepsOf,
    testProjectInput,
    withValue,
    type JsonRecord,
} from "./plan-examples.ts";

type CodeAndPath = { readonly code: string; readonly path: string };

const READ_FAILED = "reading this value is refused";

const throwOnRead = (): never => {
    throw new Error(READ_FAILED);
};

// The same items in a list that has no prototype, so it has no map, entries or iterator.
const listWithoutPrototype = (items: readonly unknown[]): unknown =>
    Object.setPrototypeOf([...items], null);

// A copy of `fields` whose field `key` is a getter that throws.
const withThrowingGetter = (fields: JsonRecord, key: string): JsonRecord =>
    Object.defineProperty({ ...fields }, key, { enumerable: true, get: throwOnRead });

// A proxy over `target` whose every trap throws, so even asking its prototype fails.
const proxyThatThrows = (target: object): unknown =>
    new Proxy(target, {
        apply: throwOnRead,
        construct: throwOnRead,
        defineProperty: throwOnRead,
        deleteProperty: throwOnRead,
        get: throwOnRead,
        getOwnPropertyDescriptor: throwOnRead,
        getPrototypeOf: throwOnRead,
        has: throwOnRead,
        isExtensible: throwOnRead,
        ownKeys: throwOnRead,
        preventExtensions: throwOnRead,
        set: throwOnRead,
        setPrototypeOf: throwOnRead,
    });

const issuesOf = (parsed: {
    readonly ok: boolean;
    readonly error?: readonly CodeAndPath[];
}): readonly CodeAndPath[] => (parsed.ok ? [] : (parsed.error ?? []));

const planIssues = (input: unknown): readonly CodeAndPath[] => issuesOf(defaultParser()(input));

const projectIssues = (input: unknown): readonly CodeAndPath[] => issuesOf(parseProject(input));

const MAXIMUM_NAME_LENGTH = 20;
const OLDEST_AGE = 150;
const readName: FieldReader<string> = (input, path, issues) =>
    readText(input, path, issues, MAXIMUM_NAME_LENGTH);
const readAge: FieldReader<number> = (input, path, issues) =>
    readInteger(input, path, issues, 0, OLDEST_AGE);
const PERSON = { name: readName, age: readAge };
const PERSON_INPUT: JsonRecord = { name: "Ada", age: 36 };

const fieldIssues = (input: unknown): readonly CodeAndPath[] => {
    const issues: Issues = [];
    readFields(input, "$", issues, PERSON);
    return issues;
};

// Index 3 of the account-closure plan is a frame step, which holds a list of steps of its own.
const FRAME_STEP_INDEX = 3;

const plainPlan = (): JsonRecord => accountClosurePlan();

const stepsOfPlainPlan = (): readonly JsonRecord[] => stepsOf(plainPlan());

const stepsInsideTheFrame = (): readonly unknown[] => {
    const inner: unknown = stepsOfPlainPlan()[FRAME_STEP_INDEX]?.["steps"];
    assert.ok(Array.isArray(inner));
    return inner;
};

const firstStep = (): JsonRecord => ({ ...stepsOfPlainPlan()[0] });

const firstMatrixEntry = (): JsonRecord => {
    const matrix: unknown = testProjectInput()["matrix"];
    assert.ok(Array.isArray(matrix));
    const entry: unknown = matrix[0];
    assert.ok(typeof entry === "object" && entry !== null);
    return { ...entry };
};

const projectOrigins = (): readonly unknown[] => {
    const origins: unknown = testProjectInput()["origins"];
    assert.ok(Array.isArray(origins));
    return origins;
};

type UnreadableCase = {
    readonly name: string;
    readonly hostile: () => unknown;
    readonly expected: readonly CodeAndPath[];
};

type ParserCases = {
    readonly parserName: string;
    readonly inputName: string;
    readonly parse: (input: unknown) => readonly CodeAndPath[];
    readonly plain: () => unknown;
    readonly cases: readonly UnreadableCase[];
};

const PARSERS: readonly ParserCases[] = [
    {
        parserName: "plan parser",
        inputName: "plan",
        parse: planIssues,
        plain: plainPlan,
        cases: [
            {
                name: "a list with no prototype as the plan",
                hostile: () => listWithoutPrototype([plainPlan()]),
                expected: [{ code: "not_object", path: "$" }],
            },
            {
                name: "a plan whose steps field has a getter that throws",
                hostile: () => withThrowingGetter(plainPlan(), "steps"),
                expected: [{ code: "not_object", path: "$" }],
            },
            {
                name: "a proxy that throws on every read as the plan",
                hostile: () => proxyThatThrows(plainPlan()),
                expected: [{ code: "not_object", path: "$" }],
            },
            {
                name: "the steps in a list with no prototype",
                hostile: () =>
                    withValue(plainPlan(), ["steps"], listWithoutPrototype(stepsOfPlainPlan())),
                expected: [{ code: "wrong_type", path: "$.steps" }],
            },
            {
                name: "the steps in a proxy over a list that throws on every read",
                hostile: () =>
                    withValue(plainPlan(), ["steps"], proxyThatThrows([...stepsOfPlainPlan()])),
                expected: [{ code: "wrong_type", path: "$.steps" }],
            },
            {
                name: "a frame step whose own steps are in a list with no prototype",
                hostile: () =>
                    withValue(
                        plainPlan(),
                        ["steps", FRAME_STEP_INDEX, "steps"],
                        listWithoutPrototype(stepsInsideTheFrame()),
                    ),
                expected: [{ code: "wrong_type", path: `$.steps[${FRAME_STEP_INDEX}].steps` }],
            },
            {
                name: "a first step whose url has a getter that throws",
                hostile: () =>
                    withValue(plainPlan(), ["steps", 0], withThrowingGetter(firstStep(), "url")),
                expected: [{ code: "not_object", path: "$.steps[0]" }],
            },
            {
                name: "a first step that is a proxy throwing on every read",
                hostile: () => withValue(plainPlan(), ["steps", 0], proxyThatThrows(firstStep())),
                expected: [{ code: "not_object", path: "$.steps[0]" }],
            },
        ],
    },
    {
        parserName: "project parser",
        inputName: "project",
        parse: projectIssues,
        plain: testProjectInput,
        cases: [
            {
                name: "a list with no prototype as the project",
                hostile: () => listWithoutPrototype([testProjectInput()]),
                expected: [{ code: "not_object", path: "$" }],
            },
            {
                name: "a project whose origins field has a getter that throws",
                hostile: () => withThrowingGetter(testProjectInput(), "origins"),
                expected: [{ code: "not_object", path: "$" }],
            },
            {
                name: "a proxy that throws on every read as the project",
                hostile: () => proxyThatThrows(testProjectInput()),
                expected: [{ code: "not_object", path: "$" }],
            },
            {
                name: "the origins in a list with no prototype",
                hostile: () =>
                    withValue(
                        testProjectInput(),
                        ["origins"],
                        listWithoutPrototype(projectOrigins()),
                    ),
                expected: [{ code: "wrong_type", path: "$.origins" }],
            },
            {
                name: "the origins in a proxy over a list that throws on every read",
                hostile: () =>
                    withValue(
                        testProjectInput(),
                        ["origins"],
                        proxyThatThrows([...projectOrigins()]),
                    ),
                expected: [{ code: "wrong_type", path: "$.origins" }],
            },
            {
                name: "a first target whose engine has a getter that throws",
                hostile: () =>
                    withValue(
                        testProjectInput(),
                        ["matrix", 0],
                        withThrowingGetter(firstMatrixEntry(), "engine"),
                    ),
                expected: [{ code: "not_object", path: "$.matrix[0]" }],
            },
            {
                name: "a first target that is a proxy throwing on every read",
                hostile: () =>
                    withValue(
                        testProjectInput(),
                        ["matrix", 0],
                        proxyThatThrows(firstMatrixEntry()),
                    ),
                expected: [{ code: "not_object", path: "$.matrix[0]" }],
            },
        ],
    },
    {
        parserName: "field table reader",
        inputName: "record",
        parse: fieldIssues,
        plain: () => ({ ...PERSON_INPUT }),
        cases: [
            {
                name: "a list with no prototype as the record",
                hostile: () => listWithoutPrototype([{ ...PERSON_INPUT }]),
                expected: [{ code: "not_object", path: "$" }],
            },
            {
                name: "a record whose name has a getter that throws",
                hostile: () => withThrowingGetter(PERSON_INPUT, "name"),
                expected: [{ code: "not_object", path: "$" }],
            },
            {
                name: "a proxy that throws on every read as the record",
                hostile: () => proxyThatThrows({ ...PERSON_INPUT }),
                expected: [{ code: "not_object", path: "$" }],
            },
        ],
    },
];

const VERSION_UNSUPPORTED_AT_THE_TOP = { code: "version-unsupported", path: "$" };

const MANIFEST_CASES: readonly { readonly name: string; readonly hostile: () => unknown }[] = [
    {
        name: "a list with no prototype",
        hostile: () => listWithoutPrototype([{ schema: "manifest" }]),
    },
    {
        name: "an object whose schema has a getter that throws",
        hostile: () => withThrowingGetter({}, "schema"),
    },
    { name: "a proxy that throws on every read", hostile: () => proxyThatThrows({}) },
];

for (const { parserName, inputName, parse, plain, cases } of PARSERS) {
    describe(`Using the ${parserName}`, () => {
        for (const { name, hostile, expected } of cases) {
            describe(`given ${name}`, () => {
                describe(`when the ${inputName} is parsed`, () => {
                    test(`then it should refuse it as ${expected.map((issue) => `${issue.code} at ${issue.path}`).join(", ")} without throwing`, () => {
                        const input = hostile();
                        let issues: readonly CodeAndPath[] = [];
                        assert.doesNotThrow(() => {
                            issues = parse(input);
                        });
                        // Only the code and the path: nothing read from the value is repeated.
                        assert.deepEqual(
                            issues.map((issue) => ({ ...issue })),
                            expected,
                        );
                    });
                });
            });
        }

        describe(`given the same ${inputName} as JSON writes it`, () => {
            describe(`when the ${inputName} is parsed`, () => {
                test("then it should accept it", () => {
                    assert.deepEqual(parse(plain()), []);
                });
            });
        });
    });
}

describe("Using the manifest decoder", () => {
    for (const { name, hostile } of MANIFEST_CASES) {
        describe(`given ${name} as a manifest`, () => {
            describe("when it is decoded", () => {
                test("then it should refuse it at the top without throwing", () => {
                    const input = hostile();
                    let decoded: unknown;
                    assert.doesNotThrow(() => {
                        decoded = decodeManifest(input);
                    });
                    assert.deepEqual(decoded, { ok: false, error: VERSION_UNSUPPORTED_AT_THE_TOP });
                });
            });
        });
    }
});
