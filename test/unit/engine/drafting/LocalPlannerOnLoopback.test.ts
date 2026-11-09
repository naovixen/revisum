import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseProject } from "@revisum/engine";
import { localPlanner, projectFile } from "../../cli/commands/examples/DraftCommand.ts";

// Codes the parser gives any URL; a local endpoint off loopback has a reason of its own.
const GENERIC_URL_CODES: readonly string[] = [
    "invalid_url",
    "scheme_not_allowed",
    "origin_not_allowed",
    "wrong_type",
    "unknown_value",
];

const OFF_LOOPBACK = [
    "http://192.168.1.20:11434",
    "http://10.0.0.5:11434",
    "http://ollama.example.org:11434",
];
const ON_LOOPBACK = [
    "http://127.0.0.1:11434",
    "http://127.1.2.3:11434",
    "http://localhost:11434",
    "http://[::1]:11434",
];

describe("Using the project parser", () => {
    for (const origin of OFF_LOOPBACK) {
        describe(`given a local planner at ${origin}, off loopback`, () => {
            describe("when the project is parsed", () => {
                test("then it should refuse the planner's url with a code of its own", () => {
                    const parsed = parseProject(projectFile(localPlanner(origin)));
                    if (parsed.ok) {
                        assert.fail("the off-loopback endpoint was accepted");
                    }
                    assert.deepEqual(
                        parsed.error.map((error) => error.path),
                        ["$.planner.url"],
                    );
                    assert.ok(
                        parsed.error.every((error) => !GENERIC_URL_CODES.includes(error.code)),
                        `refused with a generic code: ${JSON.stringify(parsed.error)}`,
                    );
                });
            });
        });
    }

    for (const origin of ON_LOOPBACK) {
        describe(`given a local planner at ${origin}, on loopback`, () => {
            describe("when the project is parsed", () => {
                test("then it should accept the planner", () => {
                    const parsed = parseProject(projectFile(localPlanner(origin)));
                    assert.ok(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.error));
                });
            });
        });
    }
});
