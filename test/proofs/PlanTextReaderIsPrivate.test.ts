// Every text a plan writes is searched for literal secrets, because only one reader reaches the
// plain text decoder. If a step's reader could import that decoder, a secret would run to a pass
// with no refusal, so the decoder is not exported to the plan's readers at all.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { REPOSITORY_ROOT } from "../support/repository.ts";

const PLAN_SOURCE_FOLDER = join(REPOSITORY_ROOT, "packages", "engine", "src", "plan");
const PLAN_DECODERS_MODULE = "../../packages/engine/src/plan/plan-decoders.ts";
const FILE_THAT_REACHES_THE_DECODER = "ReadWrittenText.ts";
const READERS_THAT_SEARCH_FOR_SECRETS: readonly string[] = [
    "readExpectedText",
    "readMultiLineText",
    "readTextOrValue",
    "readWantedText",
    "readWrittenText",
];

const IMPORT_STATEMENT = /import\s+(?!type\b)\{([^}]*)\}\s*from\s*["'][^"']+["']/g;

// The names a source imports as values, wherever the line wraps and whichever quotes it uses.
const valueNamesImportedBy = (source: string): readonly string[] =>
    [...source.matchAll(IMPORT_STATEMENT)].flatMap((statement) =>
        (statement[1] ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name !== "" && !name.startsWith("type "))
            .map((name) => name.split(/\s+as\s+/)[0] ?? name),
    );

// A whole readable plan is read by its own reader, whose own fields are parsed like any other.
const READER_OF_A_WHOLE_PLAN = "readPlanText";

const namesATextReader = (name: string): boolean =>
    /^read\w*Text/.test(name) && name !== READER_OF_A_WHOLE_PLAN;

const unsearchedReadersImportedBy = (path: string): readonly string[] =>
    valueNamesImportedBy(readFileSync(path, "utf8")).filter(
        (name) => namesATextReader(name) && !READERS_THAT_SEARCH_FOR_SECRETS.includes(name),
    );

const planSources = (): readonly string[] =>
    readdirSync(PLAN_SOURCE_FOLDER, { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".ts") && !path.endsWith(FILE_THAT_REACHES_THE_DECODER))
        .map((path) => join(PLAN_SOURCE_FOLDER, path));

describe("Using the plan decoders", () => {
    describe("given the plain text decoder", () => {
        describe("when the plan decoders are imported", () => {
            test("then it should not be among their exports", async () => {
                const planDecoders: unknown = await import(PLAN_DECODERS_MODULE);
                assert.ok(typeof planDecoders === "object" && planDecoders !== null);
                assert.equal(Object.hasOwn(planDecoders, "readText"), false);
            });
        });
    });

    describe("given every source file of the plan language", () => {
        describe("when the text readers it imports are listed", () => {
            test("then it should find the reader that searches for secrets, in a file known to use it", () => {
                const names = valueNamesImportedBy(
                    readFileSync(
                        join(PLAN_SOURCE_FOLDER, "parse", "text", "ReadFillValue.ts"),
                        "utf8",
                    ),
                );
                assert.ok(names.includes("readWrittenText"), names.join(", "));
            });

            test("then it should find only readers that search for secrets", () => {
                const offenders = planSources().flatMap((path) =>
                    unsearchedReadersImportedBy(path).map(
                        (name) => `${relative(PLAN_SOURCE_FOLDER, path)}: ${name}`,
                    ),
                );
                assert.deepEqual(offenders, []);
            });
        });
    });
});
