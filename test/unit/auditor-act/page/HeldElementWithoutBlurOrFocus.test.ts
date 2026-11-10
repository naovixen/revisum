// The Tab walk's helpers run inside the page, so a page that removed an element's blur or focus
// could throw them, and with them end the walk. Sent into the page they use its `window` alone, so a
// plain object standing in for it is enough to try them here.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
    blurHeldElement,
    refocusHeldElement,
} from "../../../../packages/auditor-act/src/in-page/HoldFocusedElement.ts";

const holding = (element: object): void => {
    Reflect.set(globalThis, "window", { __focusedElement: element });
};

afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
});

describe("Using the held element's helpers", () => {
    describe("given a held element whose blur the page removed", () => {
        describe("when focus is taken off it", () => {
            test("then it should do nothing and not throw", () => {
                holding({ blur: undefined });
                assert.doesNotThrow(blurHeldElement);
            });
        });
    });

    describe("given a held element whose focus the page removed", () => {
        describe("when its focus is given back", () => {
            test("then it should do nothing and not throw", () => {
                holding({ focus: null });
                assert.doesNotThrow(refocusHeldElement);
            });
        });
    });

    describe("given a held element that can blur and focus", () => {
        describe("when focus is taken off it and given back", () => {
            test("then it should blur it, then refocus it without scrolling", () => {
                const calls: { readonly method: string; readonly options: unknown }[] = [];
                holding({
                    blur: () => calls.push({ method: "blur", options: undefined }),
                    focus: (options: unknown) => calls.push({ method: "focus", options }),
                });
                blurHeldElement();
                refocusHeldElement();
                assert.deepEqual(calls, [
                    { method: "blur", options: undefined },
                    { method: "focus", options: { preventScroll: true } },
                ]);
            });
        });
    });

    describe("given no held element", () => {
        describe("when focus is taken off and given back", () => {
            test("then it should not throw", () => {
                Reflect.set(globalThis, "window", {});
                assert.doesNotThrow(blurHeldElement);
                assert.doesNotThrow(refocusHeldElement);
            });
        });
    });
});
