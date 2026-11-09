// The draft command's two ways of failing before its proxy runs must read differently in its output,
// each with its reason: a refused rule never reads as a port that could not be listened on, and
// neither repeats an input value.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseProxyRules } from "@revisum/runner";
import { plannerProxyStop } from "../../../../packages/cli/src/commands/DraftCommand.ts";

const SECRET = "hunter2";
const ORIGIN_WITH_A_PASSWORD = `http://user:${SECRET}@x.test/`;
const LISTEN_REASON = "listen EACCES: permission denied";
const PLANNER_CALL_FAILED = "planner-call-failed";

describe("Using the draft command's proxy stops", () => {
    describe("given a refused rule and a failed listen", () => {
        describe("when each is turned into the command's stop", () => {
            test("then it should say which it was, with the reason and no input value", () => {
                const parsed = parseProxyRules({
                    allowedOrigins: [ORIGIN_WITH_A_PASSWORD],
                    privateOrigins: [],
                    rewrites: [],
                });
                assert.ok(!parsed.ok, JSON.stringify(parsed));
                const refusedRule = plannerProxyStop(parsed.error);
                const failedListen = plannerProxyStop({
                    code: "listen-failed",
                    port: 4310,
                    message: LISTEN_REASON,
                });
                assert.equal(refusedRule.stopped.code, PLANNER_CALL_FAILED);
                assert.equal(failedListen.stopped.code, PLANNER_CALL_FAILED);
                assert.notDeepEqual(refusedRule.stopped, failedListen.stopped);
                assert.ok(
                    String(refusedRule.stopped.reason).includes(parsed.error.message),
                    JSON.stringify(refusedRule.stopped),
                );
                assert.ok(
                    String(failedListen.stopped.reason).includes(LISTEN_REASON),
                    JSON.stringify(failedListen.stopped),
                );
                assert.ok(
                    !JSON.stringify(refusedRule.stopped).includes(SECRET),
                    JSON.stringify(refusedRule.stopped),
                );
            });
        });
    });
});
