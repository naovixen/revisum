// How any session answers a dialog, and what an open dialog holds up.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { success, type DocumentSession, type Result } from "@revisum/engine";
import { isHeldByADialog } from "../IsHeldByADialog.ts";
import {
    ACCEPT,
    CLICK_EXPORT,
    EXPORT_BUTTON,
    actionStep,
    allowing,
    denying,
    failureCode,
    locatorOf,
    type OpenSessionUnderTest,
} from "./SessionUnderTest.ts";

const DIALOG_TEXT = "Keep the draft?";
const NO_ELEMENT = { role: null, name: null, box: null, formSubmitName: null, linkUrl: null };

// Each read of the whole page, none of which has anything to give while a dialog holds it.
const PAGE_READS: readonly {
    readonly name: string;
    readonly read: (
        document: DocumentSession,
    ) => Promise<Result<unknown, { readonly code: string }>>;
}[] = [
    { name: "page", read: (document) => document.page() },
    { name: "linkTargets", read: (document) => document.linkTargets() },
    { name: "accessibilitySnapshot", read: (document) => document.accessibilitySnapshot() },
    { name: "audit", read: (document) => document.audit() },
    { name: "screenshot", read: (document) => document.screenshot([]) },
    {
        name: "screenshotHidingFields",
        read: (document) => document.screenshotHidingFields([], [], () => false),
    },
];

function answeringContract(open: OpenSessionUnderTest): void {
    describe("when a dialog step is acted on and the guard allows it", () => {
        test("then it should answer it, having shown the guard its text and no element", async () => {
            const subject = await open();
            await subject.openDialog(DIALOG_TEXT);
            assert.equal(await isHeldByADialog(subject.session), true);
            const { guard, asked } = allowing();
            const acted = await subject.session.act(actionStep(ACCEPT), guard);
            assert.deepEqual(acted, success(undefined));
            assert.deepEqual(asked, [[NO_ELEMENT, DIALOG_TEXT]]);
            assert.equal(await isHeldByADialog(subject.session), false);
            const again = await subject.session.act(actionStep(ACCEPT), guard);
            assert.equal(failureCode(again), "not-found");
        });
    });

    describe("when the guard denies the answer", () => {
        test("then it should answer policy-denied and leave the dialog open", async () => {
            const subject = await open();
            await subject.openDialog(DIALOG_TEXT);
            const acted = await subject.session.act(actionStep(ACCEPT), denying().guard);
            assert.equal(failureCode(acted), "policy-denied");
            assert.equal(await isHeldByADialog(subject.session), true);
        });
    });
}

function expectedTextContract(open: OpenSessionUnderTest): void {
    describe("when the step expects other text", () => {
        test("then it should answer assertion-failed, having asked no guard", async () => {
            const subject = await open();
            await subject.openDialog(DIALOG_TEXT);
            const { guard, asked } = allowing();
            const step = actionStep({ ...ACCEPT, expectText: "Leave this page?" });
            assert.equal(failureCode(await subject.session.act(step, guard)), "assertion-failed");
            assert.deepEqual(asked, []);
        });
    });

    describe("when the step expects its text", () => {
        test("then it should answer it", async () => {
            const subject = await open();
            await subject.openDialog(DIALOG_TEXT);
            const step = actionStep({ ...ACCEPT, expectText: DIALOG_TEXT });
            const acted = await subject.session.act(step, allowing().guard);
            assert.deepEqual(acted, success(undefined));
        });
    });
}

export function dialogContract(open: OpenSessionUnderTest): void {
    describe("given no dialog open", () => {
        describe("when a dialog step is acted on", () => {
            test("then it should answer not-found, having asked no guard", async () => {
                const { session } = await open();
                const { guard, asked } = allowing();
                const acted = await session.act(actionStep(ACCEPT), guard);
                assert.equal(failureCode(acted), "not-found");
                assert.deepEqual(asked, []);
                assert.equal(await isHeldByADialog(session), false);
            });
        });
    });

    describe("given a dialog open", () => {
        answeringContract(open);
        expectedTextContract(open);

        for (const { name, read } of PAGE_READS) {
            describe(`when ${name} is asked`, () => {
                test("then it should answer dialog-open", async () => {
                    const subject = await open();
                    await subject.openDialog(DIALOG_TEXT);
                    assert.equal(failureCode(await read(subject.session)), "dialog-open");
                });

                test("then it should answer once the dialog has been answered", async () => {
                    const subject = await open();
                    await subject.openDialog(DIALOG_TEXT);
                    await subject.session.act(actionStep(ACCEPT), allowing().guard);
                    assert.equal((await read(subject.session)).ok, true);
                });
            });
        }

        describe("when a click is acted on or an element probed", () => {
            test("then it should say dialog-open, since only a dialog step can free the page", async () => {
                const subject = await open();
                await subject.openDialog(DIALOG_TEXT);
                const { guard, asked } = allowing();
                const clicked = await subject.session.act(actionStep(CLICK_EXPORT), guard);
                assert.equal(failureCode(clicked), "dialog-open");
                assert.deepEqual(asked, []);
                const probe = await subject.session.probe(locatorOf(EXPORT_BUTTON));
                assert.equal(probe.count, "dialog-open");
            });
        });
    });
}
