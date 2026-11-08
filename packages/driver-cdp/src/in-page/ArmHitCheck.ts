/// <reference lib="dom" />
// The in-page half of the click checks in HitChecks.ts: the functions that arm a press's check in the
// driver's own script world, listen for the press, and read and disarm the check. Each is sent with
// toString(), so it uses nothing from this module.
import type { Point } from "../page/PageOperations.ts";

export type ArmedHitCheck = {
    readonly element: Element;
    state: "none" | "hit" | "miss";
    readonly eventsOnTheirWay: Set<string>;
    readonly eventsArrived: Set<string>;
    report: (what: string) => void;
    isOnElement: (event: Event) => boolean;
    noteFromTheStart: (event: Event) => void;
    listen: (target: EventTarget, type: string, listener: (event: Event) => void) => void;
    stopListening: (isIncluded: (target: EventTarget) => boolean) => void;
    disarm: () => void;
};

export type WindowHoldingAHitCheck = Window & { armedHitCheck?: ArmedHitCheck | undefined };

// Sent with toString(), and run in the check's world as each document starts, so it comes before every
// listener the page can add. Named access to the page's elements reaches this world too, so only the
// world's own property counts, and a page's named element cannot hide the listener method.
export function watchClicksFromTheDocumentStart(): void {
    const world: WindowHoldingAHitCheck = window;
    for (const eventType of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        EventTarget.prototype.addEventListener.call(
            window,
            eventType,
            (event) => {
                if (event.isTrusted && Object.hasOwn(world, "armedHitCheck")) {
                    world.armedHitCheck?.noteFromTheStart(event);
                }
            },
            true,
        );
    }
}

// A form's named inputs hide its methods, and a page's named elements hide the window's, in this world
// as in the page's. So nothing here is called by looking it up on either: it comes from the prototypes.
export function armHitCheck(element: Element, bindingName: string, pressId: string): ArmedHitCheck {
    const world: WindowHoldingAHitCheck = window;
    // Each listener, so that taking them off is one step, and those on the window a step of their own.
    const listening: [EventTarget, string, (event: Event) => void][] = [];
    const check: ArmedHitCheck = {
        element,
        state: "none",
        eventsOnTheirWay: new Set(),
        eventsArrived: new Set(),
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
        noteFromTheStart: (event) => {
            if (check.isOnElement(event)) {
                check.eventsOnTheirWay.add(event.type);
                check.report(`${event.type}-on-its-way`);
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
export function listenForThePress(this: ArmedHitCheck): void {
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
    const noteArrival = (event: Event): void => {
        if (event.isTrusted) {
            this.eventsArrived.add(event.type);
            this.report(event.type);
        }
    };
    this.listen(this.element, "click", noteArrival);
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
            this.listen(target, eventType, noteArrival);
        }
    }
}

// Called on the check, as `this`. Disarms it, and says what it saw. A press that takes its element away
// leaves no click to send, so that counts as landing, unless an event of it was stopped on its way.
export function readHitCheck(this: ArmedHitCheck): string {
    this.disarm();
    if (this.state === "miss") {
        return "miss";
    }
    if (this.eventsArrived.has("click")) {
        return "hit";
    }
    if (Array.from(this.eventsOnTheirWay).some((type) => !this.eventsArrived.has(type))) {
        return "no-click";
    }
    if (this.eventsArrived.size === 0) {
        return "none";
    }
    return Reflect.get(Node.prototype, "isConnected", this.element) === true ? "no-click" : "hit";
}

// Called on the check, as `this`, once the pointer has arrived and before the press. The centre of the
// element's first box, as the wait for it measures it, or null when it has no box. Where the element is
// and nothing else: what the page has put over it is for the press to find out.
export function centreOfTheFirstBox(this: ArmedHitCheck): Point | null {
    const boxes = Array.from(Element.prototype.getClientRects.call(this.element));
    const firstBox = boxes.find((box) => box.width > 0 && box.height > 0);
    return firstBox === undefined
        ? null
        : { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height / 2 };
}

// Called on the check, as `this`, when no press is going to follow.
export function disarmUnpressedHitCheck(this: ArmedHitCheck): void {
    this.disarm();
}

// Called in a check's world. Says whether a check was still armed there.
export function disarmArmedHitCheck(): boolean {
    const world: WindowHoldingAHitCheck = window;
    // Named access to the page's elements reaches this world too, so only the world's own property counts.
    const armed = Object.hasOwn(world, "armedHitCheck") ? world.armedHitCheck : undefined;
    armed?.disarm();
    return armed !== undefined;
}
