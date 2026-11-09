// A trace under its size limit can still hold a great many short lines. Collecting its actions must
// not exhaust what one call can take: the decoder answers with a code, so a suite's output can never
// make the run reject with no result.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { parseSuiteTrace } from "@revisum/engine";
import { evidenceLimits } from "./examples/EvidenceRun.ts";
import { TRACE_ACTIONS, traceLines, zipArchive } from "./examples/ZipArchive.ts";

const SHORT_ACTION = JSON.stringify({ type: "before", title: "a" });

// Stored, not deflated: so many alike lines would otherwise be refused for their compression
// ratio, which is a different limit.
const traceWithExtraActions = (count: number): Uint8Array =>
    zipArchive([
        {
            name: "trace.trace",
            data: traceLines(
                undefined,
                Array.from({ length: count }, () => SHORT_ACTION),
            ),
            stored: true,
        },
    ]);

describe("Using the suite trace decoder", () => {
    describe("given a trace under the size limit with 500,000 short actions", () => {
        let archive: Uint8Array;

        before(() => {
            archive = traceWithExtraActions(500_000);
        });

        describe("when it is decoded", () => {
            test("then it should refuse it as too-large", () => {
                const decoded = parseSuiteTrace(archive, evidenceLimits());
                assert.equal(decoded.ok ? "accepted" : decoded.error.code, "too-large");
            });
        });
    });

    describe("given a trace with 100 short actions", () => {
        describe("when it is decoded", () => {
            test("then it should keep every action", () => {
                const decoded = parseSuiteTrace(traceWithExtraActions(100), evidenceLimits());
                assert.ok(decoded.ok, JSON.stringify(decoded));
                assert.equal(decoded.value.actions.length, TRACE_ACTIONS.length + 100);
            });
        });
    });
});
