// What the draft command says when its egress proxy goes wrong. A listener's failure during the
// planner call is reported, so a person knows the record may be incomplete, and a proxy that never
// started says why.
import assert from "node:assert/strict";
import { Server as NetServer } from "node:net";
import { describe, test, type TestContext } from "node:test";
import {
    draftArguments,
    draftWorkspace,
    localPlanner,
    recordedAnswer,
    runDraft,
    startFakePlanner,
    type DraftRun,
    type DraftWorkspace,
} from "../commands/examples/DraftCommand.ts";

const LISTENER_REASON = "accept failed on the proxy's listener";
const LISTEN_REASON = "listen EACCES: permission denied";
const PLANNER_CALL_FAILED = "planner-call-failed";
const NO_FLAGS: readonly string[] = [];

type PlannerAndWorkspace = {
    readonly workspace: DraftWorkspace;
    readonly dispose: () => Promise<void>;
};

// A local planner that runs `onAsked` as it answers, and a project that declares it.
async function plannerRunning(onAsked: () => void): Promise<PlannerAndWorkspace> {
    const answer = recordedAnswer("openai-chat");
    const planner = await startFakePlanner((received, response, earlier) => {
        onAsked();
        answer(received, response, earlier);
    });
    const workspace = draftWorkspace({ planner: localPlanner(planner.origin) });
    return {
        workspace,
        dispose: async () => {
            await planner.close();
            workspace.dispose();
        },
    };
}

// The draft command, with its proxy's listeners failing while the planner is being asked.
async function draftWithAListenerFailingDuringTheCall(
    context: TestContext,
    flags: readonly string[],
): Promise<DraftRun> {
    let failListeners = (): void => undefined;
    const running = await plannerRunning(() => {
        failListeners();
    });
    try {
        // The planner is already listening, so every listen from here on is the proxy's.
        const listen = context.mock.method(NetServer.prototype, "listen");
        failListeners = () => {
            for (const call of listen.mock.calls) {
                if (call.this instanceof NetServer) {
                    call.this.emit("error", new Error(LISTENER_REASON));
                }
            }
        };
        return await runDraft({ workspace: running.workspace, argv: draftArguments(flags) });
    } finally {
        await running.dispose();
    }
}

// The draft command when its proxy can't listen.
async function draftWithAProxyThatCannotListen(
    context: TestContext,
    flags: readonly string[],
): Promise<DraftRun> {
    const running = await plannerRunning(() => undefined);
    try {
        context.mock.method(NetServer.prototype, "listen", function (this: NetServer): NetServer {
            queueMicrotask(() => {
                this.emit("error", new Error(LISTEN_REASON));
            });
            return this;
        });
        return await runDraft({ workspace: running.workspace, argv: draftArguments(flags) });
    } finally {
        await running.dispose();
    }
}

function firstErrorOf(run: DraftRun): { readonly code: unknown; readonly reason: unknown } {
    const errors = run.output?.["errors"];
    assert.ok(Array.isArray(errors) && errors.length > 0, run.outcome.stdout);
    const first: unknown = errors[0];
    assert.ok(typeof first === "object" && first !== null, run.outcome.stdout);
    return { code: Reflect.get(first, "code"), reason: Reflect.get(first, "reason") };
}

describe("Using the draft command", () => {
    describe("given a proxy listener that fails during the planner call", () => {
        describe("when the command reports as JSON", () => {
            test("then it should finish and name the failure in its close failure", async (context) => {
                const run = await draftWithAListenerFailingDuringTheCall(context, ["--json"]);
                assert.equal(run.outcome.exitCode, 0, run.outcome.stderr);
                assert.ok(
                    String(run.output?.["closeFailure"]).includes(LISTENER_REASON),
                    run.outcome.stdout,
                );
            });
        });

        describe("when the command reports as text", () => {
            test("then it should finish and print the failure", async (context) => {
                const run = await draftWithAListenerFailingDuringTheCall(context, NO_FLAGS);
                assert.equal(run.outcome.exitCode, 0, run.outcome.stderr);
                assert.ok(run.outcome.stdout.includes(LISTENER_REASON), run.outcome.stdout);
            });
        });
    });

    describe("given a proxy that cannot listen", () => {
        describe("when the command reports as JSON", () => {
            test("then it should stop with the reason in its error", async (context) => {
                const run = await draftWithAProxyThatCannotListen(context, ["--json"]);
                const error = firstErrorOf(run);
                assert.equal(error.code, PLANNER_CALL_FAILED);
                assert.match(String(error.reason), /EACCES/);
            });
        });

        describe("when the command reports as text", () => {
            test("then it should print the reason", async (context) => {
                const run = await draftWithAProxyThatCannotListen(context, NO_FLAGS);
                assert.notEqual(run.outcome.exitCode, 0);
                assert.match(run.outcome.stderr, /EACCES/);
            });
        });
    });
});
