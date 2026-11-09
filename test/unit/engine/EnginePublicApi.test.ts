// What packages built on the engine need from its public entry point: reading a target lockfile, and
// the types that name the readable format's positions and warnings and a replay's request, ports and
// errors. The types are checked by the compiler when `tsc` reads this file, and by nothing at run
// time, so each check below is a type that only compiles when the engine exports what it names.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lock, lockToFile, replay } from "@revisum/engine";
import type {
    ReplayError,
    ReplayPorts,
    ReplayRequest,
    TextPosition,
    TextWarning,
    readLockfile,
} from "@revisum/engine";
import { engineFunction } from "./replay/examples/ManifestUnderTest.ts";

const isLockfileReaderAsynchronous: ReturnType<typeof readLockfile> extends Promise<unknown>
    ? true
    : false = true;
const isTextPositionALineAndColumn: TextPosition extends {
    readonly line: number;
    readonly column: number;
}
    ? true
    : false = true;
const isTextWarningAtAPosition: TextWarning extends { readonly position: TextPosition }
    ? true
    : false = true;
const isNotClaimedAReplayError: { readonly code: "replay-not-claimed" } extends ReplayError
    ? true
    : false = true;
const isReplayTakingItsNamedTypes: Parameters<typeof replay> extends [ReplayRequest, ReplayPorts]
    ? true
    : false = true;

describe("Using the engine's public API", () => {
    describe("given a package that reads a target lockfile", () => {
        describe("when it imports the engine", () => {
            test("then it should find readLockfile", async () => {
                await assert.doesNotReject(engineFunction("readLockfile"));
                assert.equal(isLockfileReaderAsynchronous, true);
            });

            test("then it should still find lock and lockToFile", () => {
                assert.equal(typeof lock, "function");
                assert.equal(typeof lockToFile, "function");
            });
        });
    });

    describe("given a package that names readable text positions and warnings", () => {
        describe("when it uses the engine's types", () => {
            test("then it should compile against them", () => {
                assert.equal(isTextPositionALineAndColumn, true);
                assert.equal(isTextWarningAtAPosition, true);
            });
        });
    });

    describe("given a package that replays a run", () => {
        describe("when it uses the engine's types", () => {
            test("then it should compile against them", () => {
                assert.equal(isNotClaimedAReplayError, true);
                assert.equal(isReplayTakingItsNamedTypes, true);
            });

            test("then it should find replay", () => {
                assert.equal(typeof replay, "function");
            });
        });
    });
});
