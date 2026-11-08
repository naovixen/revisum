// A clock advance runs a controller in each frame. Only a frame whose document has gone meanwhile fires
// nothing and is passed over: any other failure is the advance's failure, since a timer that did not run
// would otherwise look like a page with no timers due.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ClockAdvanceMode } from "@revisum/contracts";
import { BrowserClock } from "../../../packages/driver-cdp/src/capabilities/BrowserClock.ts";
import type { PageCommand } from "../../../packages/driver-cdp/src/capabilities/PageStorage.ts";

const ADVANCE_MILLISECONDS = 100;
const MAXIMUM_TIMERS = 10;

// What the browser answers each command the advance sends, as it would read off the socket.
type CallAnswer = { readonly reply: unknown } | { readonly rejection: Error };

const REPLIES: Readonly<Record<string, unknown>> = {
    "Page.getFrameTree": { frameTree: { frame: { id: "main-frame", url: "about:blank" } } },
    "Runtime.evaluate": { result: { type: "object", objectId: "the-document" } },
};

function pageCommandAnswering(call: CallAnswer): PageCommand {
    return (command) => {
        if (command.method === "Runtime.callFunctionOn") {
            if ("rejection" in call) {
                return Promise.reject(call.rejection);
            }
            return Promise.resolve(command.decode(call.reply));
        }
        return Promise.resolve(command.decode(REPLIES[command.method]));
    };
}

const advanceOf = async (call: CallAnswer) => {
    const clock = new BrowserClock(false);
    await clock.watchPage(pageCommandAnswering(call), () => false);
    return clock.advance(ADVANCE_MILLISECONDS, ClockAdvanceMode.RunTimers, MAXIMUM_TIMERS);
};

const FAILURES: readonly { readonly name: string; readonly call: CallAnswer }[] = [
    {
        name: "a command that fails for another reason",
        call: { rejection: new Error("Runtime.callFunctionOn: Internal error") },
    },
    {
        name: "a throw in the controller",
        call: {
            reply: {
                result: { type: "object", value: { fired: 0, runaway: false } },
                exceptionDetails: { text: "Uncaught TypeError" },
            },
        },
    },
];

describe("Using the session's clock", () => {
    for (const { name, call } of FAILURES) {
        describe(`given a frame's advance ends in ${name}`, () => {
            describe("when the clock is advanced", () => {
                test("then it should fail the advance, never succeeding with nothing fired", async () => {
                    assert.equal((await advanceOf(call)).ok, false);
                });
            });
        });
    }

    describe("given a frame whose document has gone during the advance", () => {
        describe("when the clock is advanced", () => {
            test("then it should pass that frame over and succeed", async () => {
                const gone = {
                    rejection: new Error(
                        "Runtime.callFunctionOn: Cannot find context with specified id",
                    ),
                };
                assert.deepEqual(await advanceOf(gone), { ok: true, value: undefined });
            });
        });
    });

    describe("given a frame that answers", () => {
        describe("when the clock is advanced", () => {
            test("then it should succeed", async () => {
                const answered = {
                    reply: {
                        result: { type: "object", value: { fired: 2, runaway: false } },
                    },
                };
                assert.deepEqual(await advanceOf(answered), { ok: true, value: undefined });
            });
        });
    });
});
