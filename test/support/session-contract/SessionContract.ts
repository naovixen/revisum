// What the engine may count on from any session, once it has closed, once a tab has closed, and when
// it is given a step no driver may perform or a dialog to answer. One run of this goes over the fake
// session and one over the real driver, so the two cannot drift apart.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    ClockAdvanceMode,
    success,
    type DocumentSession,
    type Result,
    type Session,
} from "@revisum/engine";
import { isHeldByADialog } from "../IsHeldByADialog.ts";
import { dialogContract } from "./DialogContract.ts";
import { refusalsContract } from "./RefusalsContract.ts";
import {
    ACCEPT,
    CLICK_EXPORT,
    EXPORT_BUTTON,
    actionStep,
    allowing,
    assertNothingRead,
    downloadStep,
    failureCode,
    firstOrigin,
    locatorFindingNothing,
    locatorOf,
    openTab,
    type OpenSessionUnderTest,
} from "./SessionUnderTest.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

const SCRIPT = {
    source: "() => 1",
    arguments: {},
    timeoutMilliseconds: 500,
    maximumResultBytes: 9,
};

type CallOn<Port> = {
    readonly name: string;
    readonly call: (port: Port) => Promise<Result<unknown, { readonly code: string }>>;
};

// Each thing a closed page's tab and session both answer with a result, and how to ask it.
const DOCUMENT_CALLS = {
    navigate: { name: "navigate", call: (document) => document.navigate("/", scriptsEnabled) },
    frame: { name: "frame", call: (document) => document.frame(locatorFindingNothing()) },
    runScript: { name: "runScript", call: (document) => document.runScript(SCRIPT) },
} as const satisfies Readonly<Record<string, CallOn<DocumentSession>>>;

// What only the session has, which a closed session answers with a crash.
const SESSION_CALLS: readonly CallOn<Session>[] = [
    { name: "storage.read", call: (session) => session.storage.read("local", firstOrigin(), "k") },
    {
        name: "storage.write",
        call: (session) => session.storage.write("local", firstOrigin(), "k", "v"),
    },
    {
        name: "storage.remove",
        call: (session) => session.storage.remove("local", firstOrigin(), "k"),
    },
    { name: "newTab", call: (session) => session.newTab("/") },
    {
        name: "clock.advance",
        call: (session) => session.clock.advance(10, ClockAdvanceMode.RunTimers, 10),
    },
    { name: "clipboard.readText", call: (session) => session.clipboard.readText(10) },
];

const PAGE_READS: readonly CallOn<DocumentSession>[] = [
    { name: "page", call: (session) => session.page() },
    { name: "screenshot", call: (session) => session.screenshot([]) },
    {
        name: "screenshotHidingFields",
        call: (session) => session.screenshotHidingFields([], [], () => false),
    },
    { name: "audit", call: (session) => session.audit() },
    { name: "accessibilitySnapshot", call: (session) => session.accessibilitySnapshot() },
    { name: "linkTargets", call: (session) => session.linkTargets() },
];

const CODES_ON_A_CLOSED_TAB: readonly (readonly [CallOn<DocumentSession>, string])[] = [
    [DOCUMENT_CALLS.navigate, "navigation-failed"],
    [DOCUMENT_CALLS.frame, "not-found"],
    [DOCUMENT_CALLS.runScript, "script-failed"],
];

function membersOfAClosedSession(open: OpenSessionUnderTest): void {
    const calls: readonly CallOn<Session>[] = [...Object.values(DOCUMENT_CALLS), ...SESSION_CALLS];
    for (const { name, call } of calls) {
        describe(`when ${name} is asked`, () => {
            test("then it should answer target-crashed", async () => {
                const { session } = await open();
                await session.close();
                assert.equal(failureCode(await call(session)), "target-crashed");
            });
        });
    }

    for (const { name, call } of PAGE_READS) {
        describe(`when ${name} is asked`, () => {
            test("then it should answer target-crashed", async () => {
                const { session } = await open();
                await session.close();
                assert.equal(failureCode(await call(session)), "target-crashed");
            });
        });
    }
}

function closedSessionContract(open: OpenSessionUnderTest): void {
    describe("given it has closed", () => {
        membersOfAClosedSession(open);

        describe("when an action or a download is asked of it", () => {
            test("then it should answer target-crashed without asking the guard", async () => {
                const { session } = await open();
                await session.close();
                const { guard, asked } = allowing();
                const step = actionStep(CLICK_EXPORT);
                assert.equal(failureCode(await session.act(step, guard)), "target-crashed");
                const saved = await session.download(downloadStep(EXPORT_BUTTON), 100, guard);
                assert.equal(failureCode(saved), "target-crashed");
                assert.deepEqual(asked, []);
            });
        });

        describe("when an element is probed", () => {
            test("then it should read nothing", async () => {
                const { session } = await open();
                await session.close();
                assertNothingRead(await session.probe(locatorOf(EXPORT_BUTTON), null));
            });
        });

        describe("when it is asked what it noted, and whether it crashed", () => {
            test("then it should still answer, and say it has", async () => {
                const { session } = await open();
                await session.close();
                assert.deepEqual(session.blockedOrigins(), []);
                assert.deepEqual(session.connectionFailures(), []);
                assert.deepEqual(session.refusedRequestDecisions(), []);
                assert.equal(session.unsupportedOpenings(), 0);
                assert.equal(await isHeldByADialog(session), false);
                assert.equal(session.crashed(), true);
            });
        });

        describe("when it is closed again", () => {
            test("then it should do nothing", async () => {
                const { session } = await open();
                await session.close();
                await session.close();
                assert.equal(session.crashed(), true);
            });
        });
    });
}

function pageOfAClosedTab(open: OpenSessionUnderTest): void {
    describe("when the tab's page is asked for", () => {
        for (const [{ name, call }, code] of CODES_ON_A_CLOSED_TAB) {
            test(`then it should answer ${name} with ${code}`, async () => {
                const tab = await openTab(await open());
                await tab.close();
                assert.equal(failureCode(await call(tab)), code);
            });
        }

        for (const { name, call } of PAGE_READS) {
            test(`then it should answer ${name} with page-unreadable`, async () => {
                const tab = await openTab(await open());
                await tab.close();
                assert.equal(failureCode(await call(tab)), "page-unreadable");
            });
        }

        test("then it should read nothing on a probe", async () => {
            const tab = await openTab(await open());
            await tab.close();
            assertNothingRead(await tab.probe(locatorOf(EXPORT_BUTTON), null));
        });
    });
}

function closedTabContract(open: OpenSessionUnderTest): void {
    describe("given a second tab that has closed", () => {
        pageOfAClosedTab(open);

        describe("when a step is acted on in the tab", () => {
            test("then it should find nothing, report no crash, and leave the session going", async () => {
                const subject = await open();
                const tab = await openTab(subject);
                await tab.close();
                const step = actionStep(CLICK_EXPORT);
                const { guard, asked } = allowing();
                assert.equal(failureCode(await tab.act(step, guard)), "not-found");
                assert.deepEqual(asked, []);
                assert.equal(tab.crashed(), false);
                assert.deepEqual(await subject.session.act(step, guard), success(undefined));
            });
        });

        describe("when a download or a dialog step runs in the tab", () => {
            test("then it should find nothing", async () => {
                const tab = await openTab(await open());
                await tab.close();
                const { guard } = allowing();
                const saved = await tab.download(downloadStep(EXPORT_BUTTON), 100, guard);
                assert.equal(failureCode(saved), "not-found");
                assert.equal(failureCode(await tab.act(actionStep(ACCEPT), guard)), "not-found");
            });
        });

        describe("when the session's storage is read after it", () => {
            test("then it should answer as it did before the tab closed", async () => {
                const subject = await open();
                const tab = await openTab(subject);
                const readStorage = () => subject.session.storage.read("local", firstOrigin(), "k");
                const before = await readStorage();
                await tab.close();
                assert.deepEqual(await readStorage(), before);
            });
        });

        describe("when the session closes after it", () => {
            test("then it should crash the session, and the tab answer as a closed tab still", async () => {
                const subject = await open();
                const tab = await openTab(subject);
                await tab.close();
                await subject.session.close();
                assert.equal(subject.session.crashed(), true);
                assert.equal(tab.crashed(), false);
                const acted = await tab.act(actionStep(CLICK_EXPORT), allowing().guard);
                assert.equal(failureCode(acted), "not-found");
            });
        });
    });
}

function openTabContract(open: OpenSessionUnderTest): void {
    describe("given a second tab", () => {
        describe("when the tab is asked to open a tab of its own", () => {
            test("then it should have no way to", async () => {
                const tab = await openTab(await open());
                assert.equal("newTab" in tab, false);
            });
        });

        describe("when the session closes with the tab still open", () => {
            test("then it should end the tab with it, answering target-crashed", async () => {
                const subject = await open();
                const tab = await openTab(subject);
                await subject.session.close();
                const { guard, asked } = allowing();
                const acted = await tab.act(actionStep(CLICK_EXPORT), guard);
                assert.equal(failureCode(acted), "target-crashed");
                assert.deepEqual(asked, []);
                assert.equal(tab.crashed(), true);
                assertNothingRead(await tab.probe(locatorOf(EXPORT_BUTTON), null));
                assert.equal(failureCode(await tab.page()), "target-crashed");
            });
        });
    });
}

export function sessionContract(open: OpenSessionUnderTest): void {
    closedSessionContract(open);
    closedTabContract(open);
    openTabContract(open);
    refusalsContract(open);
    dialogContract(open);
}
