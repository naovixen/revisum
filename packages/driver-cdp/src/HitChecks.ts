/// <reference lib="dom" />
// What decides whether a click's press reached its element. The page must not be able to write that
// answer or skew it, so the check lives in a script world of the driver's own: the page's scripts cannot
// reach its listeners, and what they patch is not what it calls. The window it is held on there is that
// world's own, not the one the page's scripts see, so it has no name they can read. Only events the
// browser made count, since a page can dispatch any other event it likes.
// A listener added when a press is armed runs after those a page added at load, which can stop an event
// before it arrives. So a listener put in that world as each document starts, ahead of all the page's,
// notes the click itself as the browser sends it. What a page cannot stop or forge settles what it does.
// While a dialog holds the page nothing in it can be read, and once its document has gone neither can
// the check. So the check also reports as it goes, ahead of whatever the page does next.
import type { PageInput, PageOperations, PageWithInput, Point } from "./page-operations.ts";

export const HitCheckOutcome = {
    Hit: "hit",
    Miss: "miss",
    // No pointer event of the press reached the element.
    None: "none",
    // The press landed on the element, with no click reaching it.
    NoClick: "no-click",
} as const;

export type HitCheckOutcome = (typeof HitCheckOutcome)[keyof typeof HitCheckOutcome];

// What a check reports as it goes. Press events are reported by their own names.
const ON_ITS_WAY = "click-on-its-way";
const CLICK_ARRIVED = "click";

type ArmedHitCheck = {
    readonly element: Element;
    state: "none" | "hit" | "miss";
    hasPressReachedElement: boolean;
    isClickOnItsWay: boolean;
    hasClickArrived: boolean;
    report: (what: string) => void;
    isOnElement: (event: Event) => boolean;
    noteClickFromTheStart: (event: Event) => void;
    listen: (target: EventTarget, type: string, listener: (event: Event) => void) => void;
    stopListening: (isIncluded: (target: EventTarget) => boolean) => void;
    disarm: () => void;
};

type WindowHoldingAHitCheck = Window & { armedHitCheck?: ArmedHitCheck | undefined };

// Sent with toString(), and run in the check's world as each document starts, so it comes before every
// listener the page can add. Named access to the page's elements reaches this world too, so only the
// world's own property counts, and a page's named element cannot hide the listener method.
function watchClicksFromTheDocumentStart(): void {
    const world: WindowHoldingAHitCheck = window;
    EventTarget.prototype.addEventListener.call(
        window,
        "click",
        (event) => {
            if (event.isTrusted && Object.hasOwn(world, "armedHitCheck")) {
                world.armedHitCheck?.noteClickFromTheStart(event);
            }
        },
        true,
    );
}

export const CLICK_WATCH_SCRIPT = `(${watchClicksFromTheDocumentStart.toString()})();`;

// Sent with toString(), like the functions of in-page.ts: no imports and no closures over Node values.
// A form's named inputs hide its methods, and a page's named elements hide the window's, in this world
// as in the page's. So nothing here is called by looking it up on either: it comes from the prototypes.
function armHitCheck(element: Element, bindingName: string, pressId: string): ArmedHitCheck {
    const world: WindowHoldingAHitCheck = window;
    // Each listener, so that taking them off is one step, and those on the window a step of their own.
    const listening: [EventTarget, string, (event: Event) => void][] = [];
    const check: ArmedHitCheck = {
        element,
        state: "none",
        hasPressReachedElement: false,
        isClickOnItsWay: false,
        hasClickArrived: false,
        report: (what) => {
            // A world the browser made before it had the binding has none, and reports nothing.
            const binding: unknown = Object.hasOwn(world, bindingName)
                ? Reflect.get(world, bindingName)
                : undefined;
            if (typeof binding === "function") {
                Reflect.apply(binding, undefined, [`${pressId} ${what}`]);
            }
        },
        isOnElement: (event) => {
            // Seen from the window, a target in a shadow root reads as its host; the composed path
            // says what it really is, through every open root.
            const path = event.composedPath();
            const innermost = path[0];
            const target = innermost instanceof Element ? innermost : null;
            const label = target === null ? null : Element.prototype.closest.call(target, "label");
            return (
                target !== null &&
                (path.includes(element) ||
                    (label instanceof HTMLLabelElement && label.control === element))
            );
        },
        noteClickFromTheStart: (event) => {
            if (check.isOnElement(event)) {
                check.isClickOnItsWay = true;
                check.report("click-on-its-way");
            }
        },
        listen: (target, type, listener) => {
            EventTarget.prototype.addEventListener.call(target, type, listener, true);
            listening.push([target, type, listener]);
        },
        stopListening: (isIncluded) => {
            for (const [target, type, listener] of listening.filter(([held]) => isIncluded(held))) {
                EventTarget.prototype.removeEventListener.call(target, type, listener, true);
            }
        },
        disarm: () => {
            // A timed-out read can disarm late, once a later press has armed a check of its own.
            if (world.armedHitCheck === check) {
                world.armedHitCheck = undefined;
            }
            check.stopListening(() => true);
        },
    };
    world.armedHitCheck = check;
    return check;
}

// Called on the check, as `this`, before the press. Pointer and mouse events whose target is not the
// element (or its label) are swallowed and recorded as a miss, so a click that lands on something else
// has no effect and fails its step. A listener on the element itself says whether the press and the
// click reached it: a page can let the press through and stop the click on its way down, and what the
// button does with a click once it has it is the button's own.
function listenForThePress(this: ArmedHitCheck): void {
    const onPointerEvent = (event: Event): void => {
        if (!event.isTrusted) {
            return;
        }
        // The click event ends the pointer sequence, so the check stops listening there. It must not
        // outlive the click: a dialog the click opens can stop the driver from reading it, and a
        // check left armed would swallow the page's own later clicks. The element's own listener stays,
        // since this click has yet to reach it, and only ever notes that it did.
        if (event.type === "click") {
            this.stopListening((target) => target === window);
        }
        if (this.isOnElement(event)) {
            this.state = this.state === "none" ? "hit" : this.state;
            return;
        }
        this.state = "miss";
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    const pressEventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup"];
    for (const eventType of [...pressEventTypes, "click"]) {
        this.listen(window, eventType, onPointerEvent);
    }
    this.listen(this.element, "click", (event) => {
        if (event.isTrusted) {
            this.hasClickArrived = true;
            this.report("click");
        }
    });
    // A press on a label reaches its control only as the click it forwards. A form's named input can
    // answer to the name, so only labels count.
    const labels: unknown = Reflect.get(this.element, "labels");
    const labelNodes = labels instanceof NodeList ? Array.from(labels) : [];
    const pressTargets = [
        this.element,
        ...labelNodes.filter((node) => node instanceof HTMLLabelElement),
    ];
    for (const target of pressTargets) {
        for (const eventType of pressEventTypes) {
            this.listen(target, eventType, (event) => {
                if (event.isTrusted) {
                    this.hasPressReachedElement = true;
                    this.report(event.type);
                }
            });
        }
    }
}

// Called on the check, as `this`. Disarms it, and says what it saw. A press that takes its element away
// leaves no click to send, so that counts as landing, unless a click was sent and stopped on its way.
function readHitCheck(this: ArmedHitCheck): string {
    this.disarm();
    if (this.state === "miss") {
        return "miss";
    }
    if (this.hasClickArrived) {
        return "hit";
    }
    if (this.isClickOnItsWay) {
        return "no-click";
    }
    if (!this.hasPressReachedElement) {
        return "none";
    }
    return Reflect.get(Node.prototype, "isConnected", this.element) === true ? "no-click" : "hit";
}

// Called in a check's world. Says whether a check was still armed there.
function disarmArmedHitCheck(): boolean {
    const world: WindowHoldingAHitCheck = window;
    // Named access to the page's elements reaches this world too, so only the world's own property counts.
    const armed = Object.hasOwn(world, "armedHitCheck") ? world.armedHitCheck : undefined;
    armed?.disarm();
    return armed !== undefined;
}

// How far a press was sent before anything stopped it. A dialog holds the release back.
export const PressSent = { HeldAtThePress: "held-at-the-press", Released: "released" } as const;
export type PressSent = (typeof PressSent)[keyof typeof PressSent];

// What a read of a press's check gave.
export type CheckRead =
    | { readonly kind: "answered"; readonly value: unknown }
    // The check's document has gone: replaced, closed or removed.
    | { readonly kind: "document-gone" }
    | { readonly kind: "held-by-dialog" }
    | { readonly kind: "failed"; readonly detail: string };

// A check armed for one press, for as long as withPressCheck runs what it is given.
export type PressCheck = {
    read(pageFunction: (this: ArmedHitCheck) => unknown): Promise<CheckRead>;
    // What the check reported before now.
    reports(): Promise<ReadonlySet<string>>;
};

const hasAny = (reports: ReadonlySet<string>, events: readonly string[]): boolean =>
    events.some((event) => reports.has(event));

const EVENTS_OF_THE_PRESS = ["pointerdown", "mousedown"];
const EVENTS_OF_THE_RELEASE = ["pointerup", "mouseup"];

// With the document still there but held by a dialog, the press landed only if the event the dialog
// opened during reached the element: a page that stops that event and opens one has only reacted to it.
function outcomeHeldByDialog(reports: ReadonlySet<string>, sent: PressSent): HitCheckOutcome {
    if (reports.has(CLICK_ARRIVED)) {
        return HitCheckOutcome.Hit;
    }
    if (reports.has(ON_ITS_WAY)) {
        return HitCheckOutcome.NoClick;
    }
    const wanted = sent === PressSent.Released ? EVENTS_OF_THE_RELEASE : EVENTS_OF_THE_PRESS;
    if (hasAny(reports, wanted)) {
        return HitCheckOutcome.Hit;
    }
    return hasAny(reports, EVENTS_OF_THE_PRESS) ? HitCheckOutcome.NoClick : HitCheckOutcome.None;
}

// With the document gone, the press landed if any of it reached the element and started the navigation.
function outcomeWithDocumentGone(reports: ReadonlySet<string>): HitCheckOutcome {
    if (reports.has(CLICK_ARRIVED)) {
        return HitCheckOutcome.Hit;
    }
    if (reports.has(ON_ITS_WAY)) {
        return HitCheckOutcome.NoClick;
    }
    return hasAny(reports, [...EVENTS_OF_THE_PRESS, ...EVENTS_OF_THE_RELEASE])
        ? HitCheckOutcome.Hit
        : HitCheckOutcome.None;
}

function decodedOutcome(reported: unknown): HitCheckOutcome {
    const outcome = Object.values(HitCheckOutcome).find((known) => known === reported);
    if (outcome === undefined) {
        throw new Error("the browser did not say what the press hit");
    }
    return outcome;
}

export type HitChecks<Handle> = {
    // Sends one press at the point, around a check armed for it, and says what became of it. Any check
    // an earlier press left armed goes first. Throws when the page cannot say: whatever is thrown says
    // nothing of where the press went, so the step fails.
    around(element: Handle, at: Point): Promise<HitCheckOutcome>;
    // All other input to the page, each sent only once any check an earlier press left armed is off, in
    // this document and every one it frames, where the input may land. Such a check would cancel a click
    // the input makes, and the input would still seem to have worked. A disarm that fails stops the
    // input, and the check stays armed for the next one to try.
    readonly input: Omit<PageInput<Handle>, "click">;
    // The document of the iframe element, with the checks that are the only way to send it input; null
    // when the element is not an iframe whose document the protocol can reach.
    frame(element: Handle): Promise<CheckedDocument<Handle> | null>;
};

export type CheckedDocument<Handle> = {
    readonly operations: PageOperations<Handle>;
    readonly checks: HitChecks<Handle>;
};

// The click checks of one document, and the only way a session sends that document input. A check
// nobody could read keeps its listeners on the page: a dialog that opens during a press holds up both
// the read and the release. So its world holds it, where any later input reaches it, whichever ports
// object sends that input, until it is disarmed or goes with its document.
export function hitChecks<Handle>(page: PageWithInput<Handle>): HitChecks<Handle> {
    const disarmLeftOvers = (): Promise<void> =>
        page.callInEveryFramedDocumentOutOfReach(disarmArmedHitCheck);
    return {
        async around(element, at) {
            await disarmLeftOvers();
            return page.withPressCheck(armHitCheck, element, async (check) => {
                const listening = await check.read(listenForThePress);
                if (listening.kind !== "answered") {
                    throw new Error("the press's check could not listen for it");
                }
                const sent = await page.click(element, at);
                const read = await check.read(readHitCheck);
                switch (read.kind) {
                    case "answered":
                        return decodedOutcome(read.value);
                    case "document-gone":
                        return outcomeWithDocumentGone(await check.reports());
                    case "held-by-dialog":
                        return outcomeHeldByDialog(await check.reports(), sent);
                    case "failed":
                        throw new Error(read.detail);
                }
            });
        },
        input: {
            async hover(at) {
                await disarmLeftOvers();
                await page.hover(at);
            },
            async fill(element, value) {
                await disarmLeftOvers();
                await page.fill(element, value);
            },
            async press(element, key, modifiers) {
                await disarmLeftOvers();
                await page.press(element, key, modifiers);
            },
            async setFiles(element, paths) {
                await disarmLeftOvers();
                await page.setFiles(element, paths);
            },
            async select(element, option) {
                await disarmLeftOvers();
                return page.select(element, option);
            },
            async callScript(source, scriptArguments, maximumResultBytes) {
                await disarmLeftOvers();
                return page.callScript(source, scriptArguments, maximumResultBytes);
            },
        },
        async frame(element) {
            const inner = await page.frame(element);
            return inner === null ? null : { operations: inner, checks: hitChecks(inner) };
        },
    };
}
