/// <reference lib="dom" />
// What decides whether a click's press reached its element. The page must not be able to write that
// answer or skew it, so the check lives in a script world of the driver's own: the page's scripts cannot
// reach its listeners, and what they patch is not what it calls. It has no name there either: the driver
// holds it through the browser, by handle. Only events the browser made count, since a page can
// dispatch any other event it likes.
import { KeptObjectGone } from "./KeptObjectGone.ts";
import type { PageOperations } from "./page-operations.ts";

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

// Sent with toString(), like the functions of in-page.ts: no imports and no closures over Node values.
// Pointer and mouse events whose target is not the element (or its label) are swallowed and recorded
// as a miss, so a click that lands on something else has no effect and fails its step. A listener on
// the element itself says whether the click reached it: a page can let the press through and stop the
// click on its way down, and what the button does with a click once it has it is the button's own.
function armHitCheck(element: Element): ArmedHitCheck {
    const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
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
    return check;
}

// Called on the check, as `this`. Disarms it, and says what it saw.
function readHitCheck(this: ArmedHitCheck): string {
    this.disarm();
    return this.state === "hit" && !this.hasClickArrived ? "no-click" : this.state;
}

function decodedOutcome(reported: unknown): HitCheckOutcome {
    const outcome = Object.values(HitCheckOutcome).find((known) => known === reported);
    if (outcome === undefined) {
        throw new Error("the browser did not say what the press hit");
    }
    return outcome;
}

export type HitChecks<Handle> = {
    // Arms one check before a press, first disarming any check an earlier click left unread.
    arm(element: Handle): Promise<Handle>;
    // Disarms the check and says what it saw. Throws when it cannot be read: its document has gone, a
    // dialog holds the page, or the answer is no outcome.
    read(check: Handle): Promise<HitCheckOutcome>;
};

// The click checks of one document. A check nobody could read keeps its listeners on the page and
// cannot be disarmed once it is forgotten, so it is held until the next arm, or goes with its document.
export function hitChecks<Handle>(operations: PageOperations<Handle>): HitChecks<Handle> {
    const unread = new Set<Handle>();
    // Not waited for: the answer the step needs is in, and the browser answers nothing to a page that
    // has started to navigate, which a click often makes it do.
    const forget = (check: Handle): void => {
        unread.delete(check);
        void operations.releaseObject(check);
    };
    // A check that has gone with its document has no listeners left to take off.
    const disarmLeftOver = async (check: Handle): Promise<void> => {
        try {
            await operations.callOnObject(check, readHitCheck);
        } catch (error) {
            if (!(error instanceof KeptObjectGone)) {
                throw error;
            }
        }
        forget(check);
    };
    return {
        async arm(element) {
            for (const leftOver of unread) {
                await disarmLeftOver(leftOver);
            }
            const check = await operations.callForObjectOutOfReach(armHitCheck, element);
            unread.add(check);
            return check;
        },
        async read(check) {
            const outcome = decodedOutcome(await operations.callOnObject(check, readHitCheck));
            forget(check);
            return outcome;
        },
    };
}
