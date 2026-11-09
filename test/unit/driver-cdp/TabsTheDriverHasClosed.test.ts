// A tab the driver has closed may never be answered again: the browser answers the close before the
// tab detaches, and a command sent in that window can go unanswered for good. So what is asked of the
// tab has to fail at once, without a word to the browser, and without counting as a crash.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { SessionTab } from "@revisum/contracts";
import { FAKE_SCRIPT_RESULT, FakeBrowserSocket } from "#test-support/fakes/FakeBrowserSocket.ts";
import { inMockTime } from "#test-support/InMockTime.ts";
import { baseUrlOf } from "#test-support/policy-clearance.ts";
import { failureCode } from "#test-support/session-contract/SessionUnderTest.ts";
import { SHARED_BROWSER_CLIPBOARD } from "../../../packages/driver-cdp/src/capabilities/RunClipboard.ts";
import {
    egressThroughExistingProxy,
    openSessionEgress,
} from "../../../packages/driver-cdp/src/capabilities/SessionEgress.ts";
import { CdpConnection } from "../../../packages/driver-cdp/src/connection/CdpConnection.ts";
import { createSession } from "../../../packages/driver-cdp/src/session/CreateSession.ts";
import type { DriverSession } from "../../../packages/driver-cdp/src/session/DriverSession.ts";
import { testProject } from "../engine/plan-examples.ts";

const DEADLINE_MILLISECONDS = 4000;
// Far short of the deadline, and long enough for mock time's own steps.
const LONGEST_PROMPT_ANSWER_MILLISECONDS = 500;
const COMMAND_TIMEOUT_MILLISECONDS = 15_000;

const SCRIPT = {
    source: "function () { return 1; }",
    arguments: {},
    timeoutMilliseconds: DEADLINE_MILLISECONDS,
    maximumResultBytes: 1024,
};

const READS_OF_A_CLOSED_TAB: readonly {
    readonly name: string;
    readonly read: (tab: SessionTab) => Promise<Parameters<typeof failureCode>[0]>;
    readonly code: string;
}[] = [
    { name: "a script is run in it", read: (tab) => tab.runScript(SCRIPT), code: "script-failed" },
    {
        name: "a screenshot hiding fields is taken of it",
        read: (tab) => tab.screenshotHidingFields([], [], () => false),
        code: "page-unreadable",
    },
];

async function sessionOn(socket: FakeBrowserSocket): Promise<DriverSession> {
    const egress = await openSessionEgress(egressThroughExistingProxy("http://127.0.0.1:1"), []);
    assert.ok(egress.ok, JSON.stringify(egress));
    const [target] = testProject().matrix;
    assert.ok(target !== undefined, "the test project has a target");
    const connection = new CdpConnection(socket, COMMAND_TIMEOUT_MILLISECONDS);
    return createSession(
        {
            connection,
            processId: 1,
            clipboardOf: () => SHARED_BROWSER_CLIPBOARD,
            close: () => {
                connection.close();
                return Promise.resolve();
            },
        },
        egress.value,
        target,
        {
            baseUrl: baseUrlOf("http://127.0.0.1:1"),
            allowedOrigins: [],
            seed: 1,
            fixedTimeMilliseconds: 0,
            sensitiveSelectors: [],
            timeoutMilliseconds: DEADLINE_MILLISECONDS,
        },
        undefined,
    );
}

describe("Using a second tab of a session", () => {
    describe("given a tab the driver has closed, whose page the browser no longer answers", () => {
        let socket: FakeBrowserSocket;
        let session: DriverSession;
        let tab: SessionTab;

        beforeEach(async () => {
            socket = new FakeBrowserSocket();
            session = await sessionOn(socket);
            const opened = await session.newTab("/");
            assert.ok(opened.ok, JSON.stringify(opened));
            tab = opened.value;
            await tab.close();
        });

        afterEach(async () => {
            await session.close();
        });

        for (const { name, read, code } of READS_OF_A_CLOSED_TAB) {
            describe(`when ${name}`, () => {
                test(`then it should answer ${code} long before its deadline`, async (context) => {
                    const { value, elapsed } = await inMockTime(context, () => read(tab));
                    assert.equal(failureCode(value), code);
                    assert.ok(
                        elapsed <= LONGEST_PROMPT_ANSWER_MILLISECONDS,
                        `it took ${elapsed} ms of mock time`,
                    );
                });

                test("then it should send the browser nothing for that page", async (context) => {
                    await inMockTime(context, () => read(tab));
                    assert.deepEqual(socket.commandsSentToClosedPages(), []);
                });
            });
        }

        describe("when its state is read", () => {
            test("then it should not count as crashed", () => {
                assert.equal(tab.crashed(), false);
            });

            test("then it should not count the session's first page as crashed", () => {
                assert.equal(session.crashed(), false);
            });
        });

        describe("when a script is run in the session's first page", () => {
            test("then it should answer as before", async (context) => {
                const { value } = await inMockTime(context, () => session.runScript(SCRIPT));
                assert.deepEqual(value, { ok: true, value: FAKE_SCRIPT_RESULT });
            });
        });
    });
});
