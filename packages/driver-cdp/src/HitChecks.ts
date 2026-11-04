/// <reference lib="dom" />
// What decides whether a click's press reached its element. The page must not be able to write that
// answer or skew it, so the check lives in a script world of the driver's own: the page's scripts cannot
// reach its listeners, and what they patch is not what it calls. The window it is held on there is that
// world's own, not the one the page's scripts see, so it has no name they can read. Only events the
// browser made count, since a page can dispatch any other event it likes.
import { KeptObjectGone } from "./KeptObjectGone.ts";
import type { PageInput, PageWithInput, Point } from "./page-operations.ts";

export const HitCheckOutcome = {
    Hit: "hit",
    Miss: "miss",
    // No pointer event of the press reached the check.
    None: "none",
    // The press landed on the element, with no click reaching it.
    NoClick: "no-click",
} as const;

export type HitCheckOutcome = (typeof HitCheckOutcome)[keyof typeof HitCheckOutcome];

type ArmedHitCheck = {
    state: "none" | "hit" | "miss";
    hasClickArrived: boolean;
    disarm: () => void;
};

type WindowHoldingAHitCheck = Window & { armedHitCheck?: ArmedHitCheck | undefined };

// Sent with toString(), like the functions of in-page.ts: no imports and no closures over Node values.
// Pointer and mouse events whose target is not the element (or its label) are swallowed and recorded
// as a miss, so a click that lands on something else has no effect and fails its step. A listener on
// the element itself says whether the click reached it: a page can let the press through and stop the
// click on its way down, and what the button does with a click once it has it is the button's own.
function armHitCheck(element: Element): ArmedHitCheck {
    const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    const world: WindowHoldingAHitCheck = window;
    const stopListeningOnWindow = (): void => {
        for (const eventType of eventTypes) {
            window.removeEventListener(eventType, onPointerEvent, true);
        }
    };
    const onClickAtElement = (event: Event): void => {
        if (event.isTrusted) {
            check.hasClickArrived = true;
        }
    };
    const check: ArmedHitCheck = {
        state: "none",
        hasClickArrived: false,
        disarm: () => {
            stopListeningOnWindow();
            element.removeEventListener("click", onClickAtElement, true);
            world.armedHitCheck = undefined;
        },
    };
    function onPointerEvent(event: Event): void {
        if (!event.isTrusted) {
            return;
        }
        // Seen from the window, a target in a shadow root reads as its host; the composed path says
        // what it really is, through every open root.
        const path = event.composedPath();
        const innermost = path[0];
        const target = innermost instanceof Element ? innermost : null;
        const label = target?.closest("label");
        const isOnElement =
            target !== null && (path.includes(element) || label?.control === element);
        // The click event ends the pointer sequence, so the check stops listening there. It must not
        // outlive the click: a dialog the click opens can stop the driver from reading it, and a
        // check left armed would swallow the page's own later clicks. The element's own listener stays,
        // since this click has yet to reach it, and only ever notes that it did.
        if (event.type === "click") {
            stopListeningOnWindow();
        }
        if (isOnElement) {
            if (check.state === "none") {
                check.state = "hit";
            }
            return;
        }
        check.state = "miss";
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    for (const eventType of eventTypes) {
        window.addEventListener(eventType, onPointerEvent, true);
    }
    element.addEventListener("click", onClickAtElement, true);
    world.armedHitCheck = check;
    return check;
}

// Called on the check, as `this`. Disarms it, and says what it saw.
function readHitCheck(this: ArmedHitCheck): string {
    this.disarm();
    return this.state === "hit" && !this.hasClickArrived ? "no-click" : this.state;
}

// Called in the check's world. Says whether a check was still armed there.
function disarmArmedHitCheck(): boolean {
    const world: WindowHoldingAHitCheck = window;
    const armed = world.armedHitCheck;
    armed?.disarm();
    return armed !== undefined;
}

function decodedOutcome(reported: unknown): HitCheckOutcome {
    const outcome = Object.values(HitCheckOutcome).find((known) => known === reported);
    if (outcome === undefined) {
        throw new Error("the browser did not say what the press hit");
    }
    return outcome;
}

export type ArmedClick = {
    // Sends the press the check is armed for.
    press(at: Point): Promise<void>;
    // Disarms the check and says what it saw. Throws when it cannot be read: its document has gone, a
    // dialog holds the page, or the answer is no outcome.
    read(): Promise<HitCheckOutcome>;
};

export type HitChecks<Handle> = {
    // Arms one check for a press, first disarming any check an earlier press left armed.
    arm(element: Handle): Promise<ArmedClick>;
    // All other input to the page, each sent only once any check an earlier press left armed is off.
    // Such a check would cancel a click the input makes, and the input would still seem to have worked.
    // A disarm that fails stops the input, and the check stays armed for the next one to try.
    readonly input: Omit<PageInput<Handle>, "click">;
};

// The click checks of one document, and the only way a session sends that document input. A check
// nobody could read keeps its listeners on the page: a dialog that opens during a press holds up both
// the read and the release. So its world holds it, where any later input reaches it, whichever ports
// object sends that input, until it is disarmed or goes with its document.
export function hitChecks<Handle>(page: PageWithInput<Handle>): HitChecks<Handle> {
    // A document that has gone took its check with it, so there are no listeners left to take off. The
    // object kept for a check nobody could read is let go here: while the dialog held the page it could
    // not be. Not waited for, as a page that has started to navigate answers nothing, and the browser
    // has it before anything sent after this.
    const disarmLeftOver = async (): Promise<void> => {
        try {
            if ((await page.callOutOfReach(disarmArmedHitCheck)) === true) {
                void page.releaseObjectsOutOfReach();
            }
        } catch (error) {
            if (!(error instanceof KeptObjectGone)) {
                throw error;
            }
        }
    };
    return {
        async arm(element) {
            await disarmLeftOver();
            const check = await page.callForObjectOutOfReach(armHitCheck, element);
            return {
                press: (at) => page.click(element, at),
                async read() {
                    const reported = await page.callOnObject(check, readHitCheck);
                    // Not waited for: the answer the step needs is in, and the browser answers nothing
                    // to a page that has started to navigate, which a click often makes it do.
                    void page.releaseObject(check);
                    return decodedOutcome(reported);
                },
            };
        },
        input: {
            async hover(at) {
                await disarmLeftOver();
                await page.hover(at);
            },
            async fill(element, value) {
                await disarmLeftOver();
                await page.fill(element, value);
            },
            async press(element, key, modifiers) {
                await disarmLeftOver();
                await page.press(element, key, modifiers);
            },
            async setFiles(element, paths) {
                await disarmLeftOver();
                await page.setFiles(element, paths);
            },
        },
    };
}
