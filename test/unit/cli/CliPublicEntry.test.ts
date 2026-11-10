// A protected branch that holds whatever it is handed would let a caller trust any project. It is only
// for the benchmark inside the cli, so nothing reachable from the public entry hands it out.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildAdapters } from "@revisum/cli";

const NAME = "protectedBranchHolding";

describe("Using the cli's public entry", () => {
    describe("given its exports", () => {
        describe("when they are read", () => {
            test("then it should not export the benchmark's protected branch", async () => {
                const exported = await import("@revisum/cli");
                assert.equal(Object.keys(exported).includes(NAME), false);
            });
        });
    });

    describe("given the benchmark's ports", () => {
        describe("when they are built", () => {
            test("then it should not hand out the benchmark's protected branch", () => {
                const ports = buildAdapters.benchmarkPorts({ executablePath: "never-launched" });
                assert.equal(NAME in ports, false);
            });
        });
    });
});
