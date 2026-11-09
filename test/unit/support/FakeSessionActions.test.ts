// What a fake session does with an action: it asks the guard, honours the byte limit and refuses once
// closed, as the port says a driver must, so a run on it ends as a run on a driver would. What it
// shares with the real driver is pinned in SessionContractOnTheFake; this is what only a fake can say.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    failure,
    success,
    type ActionGuard,
    type GuardVerdict,
    type Origin,
    type PerformableAction,
    type ResolvedDownloadStep,
    type ResolvedElement,
} from "@revisum/engine";
import { performableActionOf, resolvedDownloadOf } from "#test-support/PerformableActionOf.ts";
import { FAKE_DOWNLOAD, fakeSession } from "#test-support/fakes/session/FakeSession.ts";
import { isHeldByADialog } from "#test-support/IsHeldByADialog.ts";
import { failureCode as failureCodeOf } from "#test-support/session-contract/SessionUnderTest.ts";
import { testProject } from "../engine/plan/examples/GoldenPlan.ts";
import {
    OPEN_ACCOUNT_PAGE,
    acceptDialog,
    click,
    parsedPlan,
    planOf,
    policyProjectInput,
    role,
    stepAt,
    testId,
    type JsonRecord,
} from "../engine/policy/examples/Policy.ts";

const ALLOW: GuardVerdict = { kind: "allow" };
const DENY: GuardVerdict = { kind: "deny", rule: "irreversible-action", stepIndex: 1 };
const NAMED_BUTTON = role("button", "Export");
const UNNAMED_ELEMENT: ResolvedElement = {
    role: null,
    name: null,
    box: null,
    formSubmitName: null,
    linkUrl: null,
};
const CLICK_EXPORT: JsonRecord = click(NAMED_BUTTON);
const TOLD_PAGE = { url: "https://app.example/told", title: "Told", meta: [], canonicalUrl: null };
const [ORIGIN = assert.fail("the test project declares an origin")]: readonly Origin[] =
    testProject().origins;

// A guard that answers `verdict` and keeps what it was asked.
function guardAnswering(verdict: GuardVerdict): {
    readonly guard: ActionGuard;
    readonly asked: readonly (readonly [ResolvedElement, string | null])[];
} {
    const asked: (readonly [ResolvedElement, string | null])[] = [];
    return {
        asked,
        guard: (element, dialogText) => {
            asked.push([element, dialogText]);
            return verdict;
        },
    };
}

const secondStepOf = (raw: JsonRecord) => stepAt(parsedPlan(planOf([OPEN_ACCOUNT_PAGE, raw])), 1);

function actionStep(raw: JsonRecord): PerformableAction {
    const step = secondStepOf(raw);
    assert.ok(step.type === "click" || step.type === "dialog", JSON.stringify(step));
    return performableActionOf(step);
}

function downloadStep(): ResolvedDownloadStep {
    const step = secondStepOf({ type: "download", name: "report", locator: NAMED_BUTTON });
    assert.ok(step.type === "download", JSON.stringify(step));
    return resolvedDownloadOf(step);
}

describe("Using a fake session", () => {
    describe("given a guard that allows the action", () => {
        describe("when a click on a named control is acted on", () => {
            test("then it should succeed, having asked the guard once about that control", async () => {
                const { guard, asked } = guardAnswering(ALLOW);
                const acted = await fakeSession().act(actionStep(CLICK_EXPORT), guard);
                assert.deepEqual(acted, success(undefined));
                assert.deepEqual(asked, [
                    [{ ...UNNAMED_ELEMENT, role: "button", name: "Export" }, null],
                ]);
            });
        });

        describe("when a click on a test id is acted on", () => {
            test("then it should tell the guard the test id and no name", async () => {
                const { guard, asked } = guardAnswering(ALLOW);
                await fakeSession().act(actionStep(click(testId("save"))), guard);
                assert.deepEqual(asked, [[{ ...UNNAMED_ELEMENT, testId: "save" }, null]]);
            });
        });

        describe("when a dialog step is acted on with a dialog open", () => {
            test("then it should ask the guard about no element, with the dialog's text", async () => {
                const session = fakeSession();
                session.openDialog("Keep the draft?");
                const { guard, asked } = guardAnswering(ALLOW);
                const acted = await session.act(actionStep(acceptDialog), guard);
                assert.deepEqual(acted, success(undefined));
                assert.deepEqual(asked, [[UNNAMED_ELEMENT, "Keep the draft?"]]);
            });
        });

        describe("when a dialog step is acted on with no dialog open", () => {
            test("then it should answer not-found, having asked no guard", async () => {
                const { guard, asked } = guardAnswering(ALLOW);
                const acted = await fakeSession().act(actionStep(acceptDialog), guard);
                assert.deepEqual(
                    acted,
                    failure({ code: "not-found", detail: "no dialog is open" }),
                );
                assert.deepEqual(asked, []);
            });
        });

        describe("when a click on a css selector is acted on", () => {
            test("then it should tell the guard nothing of the element", async () => {
                const { guard, asked } = guardAnswering(ALLOW);
                const css = { by: "css", selector: "#save" };
                const step = stepAt(
                    parsedPlan(
                        planOf([OPEN_ACCOUNT_PAGE, click(css)]),
                        policyProjectInput({ unsafeFeatures: { cssLocators: true } }),
                    ),
                    1,
                );
                assert.ok(step.type === "click", JSON.stringify(step));
                const acted = await fakeSession().act(performableActionOf(step), guard);
                assert.deepEqual(acted, success(undefined));
                assert.deepEqual(asked, [[UNNAMED_ELEMENT, null]]);
            });
        });

        describe("when a download step runs within its byte limit", () => {
            test("then it should save the file, having asked the guard once", async () => {
                const { guard, asked } = guardAnswering(ALLOW);
                const saved = await fakeSession().download(
                    downloadStep(),
                    FAKE_DOWNLOAD.length,
                    guard,
                );
                assert.ok(saved.ok);
                assert.deepEqual(saved.value.bytes, FAKE_DOWNLOAD);
                assert.equal(asked.length, 1);
            });
        });

        describe("when a download step's file is past its byte limit", () => {
            test("then it should fail with download-too-large", async () => {
                const saved = await fakeSession().download(
                    downloadStep(),
                    FAKE_DOWNLOAD.length - 1,
                    guardAnswering(ALLOW).guard,
                );
                assert.ok(!saved.ok);
                assert.equal(saved.error.code, "download-too-large");
            });
        });
    });

    describe("given a guard that denies the action", () => {
        describe("when a step is acted on", () => {
            test("then it should answer policy-denied, naming the rule", async () => {
                const { guard, asked } = guardAnswering(DENY);
                const acted = await fakeSession().act(actionStep(CLICK_EXPORT), guard);
                assert.deepEqual(
                    acted,
                    failure({
                        code: "policy-denied",
                        detail: "denied by the irreversible-action rule",
                    }),
                );
                assert.equal(asked.length, 1);
            });
        });

        describe("when a download step runs", () => {
            test("then it should answer policy-denied and save nothing", async () => {
                const { guard, asked } = guardAnswering(DENY);
                const saved = await fakeSession().download(downloadStep(), 1000, guard);
                assert.ok(!saved.ok);
                assert.equal(saved.error.code, "policy-denied");
                assert.equal(asked.length, 1);
            });
        });
    });

    describe("given it has closed", () => {
        describe("when a step is acted on", () => {
            test("then it should refuse as the real driver does, without asking the guard", async () => {
                const session = fakeSession();
                await session.close();
                const { guard, asked } = guardAnswering(ALLOW);
                const acted = await session.act(actionStep(CLICK_EXPORT), guard);
                assert.ok(!acted.ok);
                assert.equal(acted.error.code, "target-crashed");
                assert.deepEqual(asked, []);
            });
        });

        describe("when a download step runs", () => {
            test("then it should refuse as the real driver does, without asking the guard", async () => {
                const session = fakeSession();
                await session.close();
                const { guard, asked } = guardAnswering(ALLOW);
                const saved = await session.download(downloadStep(), 1000, guard);
                assert.ok(!saved.ok);
                assert.equal(saved.error.code, "target-crashed");
                assert.deepEqual(asked, []);
            });
        });

        describe("when a test asks whether it crashed", () => {
            test("then it should say so, as it did not before it closed", async () => {
                const session = fakeSession();
                const wasCrashedBeforeClosing = session.crashed();
                await session.close();
                assert.deepEqual([wasCrashedBeforeClosing, session.crashed()], [false, true]);
            });
        });
    });

    describe("given a second tab open", () => {
        describe("when the tab closes", () => {
            test("then it should go on acting, until the session itself closes", async () => {
                const session = fakeSession();
                const tab = await session.newTab("https://app.example/other");
                assert.ok(tab.ok);
                await tab.value.close();
                const step = actionStep(CLICK_EXPORT);
                const { guard } = guardAnswering(ALLOW);
                assert.equal((await session.act(step, guard)).ok, true);
                await session.close();
                assert.equal((await session.act(step, guard)).ok, false);
            });
        });

        describe("when the session was told how to answer", () => {
            test("then it should have the tab answer the same way, with its own calls", async () => {
                const session = fakeSession({ page: () => Promise.resolve(success(TOLD_PAGE)) });
                const tab = await session.newTab("https://app.example/other");
                assert.ok(tab.ok);
                assert.deepEqual(await tab.value.page(), success(TOLD_PAGE));
                assert.equal(session.calls.count("page"), 0);
            });
        });

        describe("when a dialog opens on the tab", () => {
            test("then it should hold the tab and leave the session's page free", async () => {
                const session = fakeSession();
                await session.newTab("https://app.example/other");
                const [tab] = session.openedTabs();
                tab?.openDialog("Keep the draft?");
                assert.ok(tab !== undefined, "the tab opened");
                assert.equal(await isHeldByADialog(tab), true);
                assert.equal(await isHeldByADialog(session), false);
            });
        });

        describe("when the session's storage is written and the tab closes", () => {
            test("then it should go on reading what was written", async () => {
                const session = fakeSession();
                const opened = await session.newTab("https://app.example/other");
                assert.ok(opened.ok);
                await session.storage.write("local", ORIGIN, "key", "value");
                await opened.value.close();
                assert.deepEqual(
                    await session.storage.read("local", ORIGIN, "key"),
                    success("value"),
                );
            });
        });

        describe("when a test asks what the tab offers", () => {
            test("then it should hold only a document's members", async () => {
                const session = fakeSession();
                const opened = await session.newTab("https://app.example/other");
                assert.ok(opened.ok);
                for (const member of ["newTab", "storage", "network", "clock", "clipboard"]) {
                    assert.equal(member in opened.value, false, member);
                }
            });
        });
    });

    describe("given a test's own answer", () => {
        describe("when it is asked for after the session has closed", () => {
            test("then it should give way to the closed session's", async () => {
                const session = fakeSession({ page: () => Promise.resolve(success(TOLD_PAGE)) });
                await session.close();
                assert.equal(failureCodeOf(await session.page()), "target-crashed");
            });
        });
    });

    describe("given a copy of the session made while it was open", () => {
        describe("when the session closes", () => {
            test("then it should end the copy with it", async () => {
                const session = fakeSession();
                const copy = { ...session };
                await session.close();
                const acted = await copy.act(actionStep(CLICK_EXPORT), guardAnswering(ALLOW).guard);
                assert.ok(!acted.ok);
                assert.equal(acted.error.code, "target-crashed");
            });
        });
    });

    describe("given its close fails", () => {
        describe("when a step is acted on after that", () => {
            test("then it should still act, since nothing closed", async () => {
                const session = fakeSession({
                    close: () => Promise.reject(new Error("will not close")),
                });
                await assert.rejects(session.close(), { message: "will not close" });
                const acted = await session.act(
                    actionStep(CLICK_EXPORT),
                    guardAnswering(ALLOW).guard,
                );
                assert.equal(acted.ok, true);
            });
        });
    });
});
