// An Origin means "read by the one reader": two readers can disagree about what an origin is, as a
// runner that took ftp did while the project parser refused it. So only one module in contracts, which
// both the engine and the runner can use, may make the brand.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { PACKAGES, REPOSITORY_ROOT } from "#test-support/repository/RepositoryRoot.ts";

const CONTRACTS_SOURCE = "packages/contracts/src/";
const LINE_COMMENT = /\/\/.*$/gm;
// Both quote styles, and either form spread over several lines.
const MAKES_AN_ORIGIN = [/\bas\s+Origin\b/, /\bbrand\s*<\s*string\s*,\s*["']Origin["']\s*>/];

const sourceFiles = (): readonly string[] =>
    readdirSync(PACKAGES, { recursive: true, encoding: "utf8" })
        .filter(
            (path) =>
                path.endsWith(".ts") &&
                !path.endsWith(".d.ts") &&
                !/(^|[\\/])(node_modules|dist)[\\/]/.test(path),
        )
        .map((path) => join(PACKAGES, path));

const makesAnOrigin = (file: string): boolean => {
    const code = readFileSync(file, "utf8").replace(LINE_COMMENT, "");
    return MAKES_AN_ORIGIN.some((form) => form.test(code));
};

describe("Using the origin reader", () => {
    describe("given every package's source", () => {
        describe("when the modules that make an Origin are listed", () => {
            test("then it should find one, in contracts", () => {
                const makers = sourceFiles()
                    .filter(makesAnOrigin)
                    .map((file) => relative(REPOSITORY_ROOT, file).replaceAll("\\", "/"));
                assert.equal(makers.length, 1, makers.join(", "));
                assert.ok(makers[0]?.startsWith(CONTRACTS_SOURCE) === true, makers.join(", "));
            });
        });
    });
});
