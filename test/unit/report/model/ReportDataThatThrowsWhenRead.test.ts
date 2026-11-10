// Report data is unknown until it is parsed, and the parsers promise a result for every value they
// are handed, not just for what JSON.parse makes. A field whose getter throws or a proxy that throws
// is refused as a list of { path, code } entries, and never thrown.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseHistory, parseReportInput } from "@revisum/report";
import {
    listWithoutPrototype,
    proxyThatThrows,
    revokedProxy,
    withThrowingGetter,
} from "#test-support/ProxyThatThrows.ts";
import { REPORT_INPUTS } from "../../../support/builders/ReportInputs.ts";
import { withValue, type JsonRecord } from "../../engine/plan/examples/GoldenPlan.ts";

const readInput = (name: string): JsonRecord =>
    JSON.parse(readFileSync(join(REPORT_INPUTS, `${name}.json`), "utf8")) as JsonRecord;

type Parser = {
    readonly parserName: string;
    readonly parse: (input: unknown) => { readonly ok: boolean; readonly error?: unknown };
    readonly fixture: string;
    readonly topField: string;
    readonly listField: string;
};

const PARSERS: readonly Parser[] = [
    {
        parserName: "parseReportInput",
        parse: parseReportInput,
        fixture: "functional",
        topField: "schema",
        listField: "findings",
    },
    {
        parserName: "parseHistory",
        parse: parseHistory,
        fixture: "history",
        topField: "schema",
        listField: "periods",
    },
];

const HOSTILE_INPUTS: readonly {
    readonly name: string;
    readonly hostile: (input: JsonRecord, parser: Parser) => unknown;
}[] = [
    {
        name: "a top field with a getter that throws",
        hostile: (input, parser) => withThrowingGetter(input, parser.topField),
    },
    {
        name: "a proxy that throws on every read in place of the input",
        hostile: (input) => proxyThatThrows(input),
    },
    { name: "a revoked proxy in place of the input", hostile: (input) => revokedProxy(input) },
    {
        name: "a list field in a proxy that throws on every read",
        hostile: (input, parser) => withValue(input, [parser.listField], proxyThatThrows([])),
    },
    {
        name: "a list field in a revoked proxy",
        hostile: (input, parser) => withValue(input, [parser.listField], revokedProxy([])),
    },
    {
        name: "a list field in a list with no prototype",
        hostile: (input, parser) => withValue(input, [parser.listField], listWithoutPrototype([])),
    },
    {
        name: "a first list item with a getter that throws",
        hostile: (input, parser) =>
            withValue(input, [parser.listField, 0], withThrowingGetter({}, "id")),
    },
];

const isPathAndCode = (entry: unknown): boolean =>
    typeof entry === "object" &&
    entry !== null &&
    "path" in entry &&
    "code" in entry &&
    typeof entry.path === "string" &&
    typeof entry.code === "string";

for (const parser of PARSERS) {
    describe(`Using ${parser.parserName}`, () => {
        for (const { name, hostile } of HOSTILE_INPUTS) {
            describe(`given ${name}`, () => {
                describe("when it is parsed", () => {
                    test("then it should refuse it with a list of paths and codes without throwing", () => {
                        const input = hostile(readInput(parser.fixture), parser);
                        const parsed = parser.parse(input);
                        assert.equal(parsed.ok, false);
                        const error: unknown = parsed.error;
                        assert.ok(Array.isArray(error) && error.length > 0);
                        assert.ok(error.every(isPathAndCode), JSON.stringify(error));
                    });
                });
            });
        }
    });
}
