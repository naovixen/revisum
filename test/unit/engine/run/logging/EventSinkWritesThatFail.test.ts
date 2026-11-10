// An audit entry that did not reach the file was not recorded, so the sink must say so.
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, type TestContext } from "node:test";
import {
    jsonLinesEventSink,
    type DerivedActor,
    type EventInput,
    type EventSink,
} from "@revisum/engine";
import { AuditEventKind, ActorType } from "@revisum/contracts";

// No minting code exists for tests, so this one place builds the actor directly.
const ACTOR = { actor: "actor-hash", actorType: ActorType.Agent } as DerivedActor;
const SUBMITTED: EventInput = { kind: AuditEventKind.PlanSubmitted, runId: "run-0001" };
const FINISHED: EventInput = { kind: AuditEventKind.RunFinished, runId: "run-0001" };

let folder: string;
let path: string;
let sink: EventSink;

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "event-sink-failing-"));
    path = join(folder, "audit.jsonl");
    sink = jsonLinesEventSink(path);
});

afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
});

function whileAppendingFails<Answer>(context: TestContext, action: () => Answer): Answer {
    const failing = context.mock.method(fs, "appendFileSync", () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    syncBuiltinESMExports();
    try {
        return action();
    } finally {
        failing.mock.restore();
        syncBuiltinESMExports();
    }
}

describe("Using the JSON Lines event sink", () => {
    describe("given a file that cannot be appended to", () => {
        describe("when an event is appended", () => {
            test("then it should answer write-failed", (context) => {
                const appended = whileAppendingFails(context, () => sink.append(SUBMITTED, ACTOR));

                assert.deepEqual(appended, { ok: false, error: { code: "write-failed" } });
            });
        });

        describe("and the append failed once", () => {
            describe("when a later event is appended", () => {
                test("then it should record that event as the first entry", (context) => {
                    whileAppendingFails(context, () => sink.append(SUBMITTED, ACTOR));

                    const appended = sink.append(FINISHED, ACTOR);

                    assert.deepEqual(appended, { ok: true, value: { sequence: 0 } });
                    assert.match(readFileSync(path, "utf8"), /run\.finished/);
                });
            });
        });
    });
});
