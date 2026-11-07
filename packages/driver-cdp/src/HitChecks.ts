/// <reference lib="dom" />
// What decides whether a click's press reached its element. The page must not be able to write that
// answer or skew it, so the check lives in a script world of the driver's own: the page's scripts cannot
// reach its listeners, and what they patch is not what it calls. The window it is held on there is that
// world's own, not the one the page's scripts see, so it has no name they can read. Only events the
// browser made count, since a page can dispatch any other event it likes.
// A listener added when a press is armed runs after those a page added at load, which can stop an event
// before it arrives. So a listener put in that world as each document starts, ahead of all the page's,
// notes each event of the press as the browser sends it. What a page cannot stop or forge settles what
// it does: an event that was on its way and never reached the element was stopped, or held by a dialog.
// While a dialog holds the page nothing in it can be read, and once its document has gone neither can
// the check. So the check also reports as it goes, ahead of whatever the page does next.
import type {
    HasStepEnded,
    PageInput,
    PageOperations,
    PageWithInput,
    Point,
} from "./page-operations.ts";
import {
    armHitCheck,
    centreOfTheFirstBox,
    disarmArmedHitCheck,
    disarmUnpressedHitCheck,
    listenForThePress,
    readHitCheck,
    watchClicksFromTheDocumentStart,
} from "./ArmHitCheck.ts";
import { PageHeldByDialog } from "./PageHeldByDialog.ts";
import { PressSent, type PressCheck } from "./PressCheck.ts";

export const HitCheckOutcome = {
    Hit: "hit",
    Miss: "miss",
    // No event of the press was on its way to the element, or reached it.
    None: "none",
    // An event of the press was on its way to the element and never reached it, or the press ended with
    // no click sent to it.
    NoClick: "no-click",
    // The pointer's arrival left the element somewhere else, or nowhere, so no press was sent.
    MovedBeforeThePress: "moved-before-the-press",
} as const;

export type HitCheckOutcome = (typeof HitCheckOutcome)[keyof typeof HitCheckOutcome];

// What a check reports as it goes: an event arriving at the element by its own name, and one on its way
// to the element by that name with this after it. The page-side functions spell it out, as they must.
const ON_ITS_WAY = "-on-its-way";
const CLICK_ARRIVED = "click";

export const CLICK_WATCH_SCRIPT = `(${watchClicksFromTheDocumentStart.toString()})();`;

const hasAny = (reports: ReadonlySet<string>, events: readonly string[]): boolean =>
    events.some((event) => reports.has(event));

const EVENTS_OF_THE_PRESS = ["pointerdown", "mousedown"];
const EVENTS_OF_THE_RELEASE = ["pointerup", "mouseup"];

const wasAnEventStoppedOnItsWay = (reports: ReadonlySet<string>): boolean =>
    [...EVENTS_OF_THE_PRESS, ...EVENTS_OF_THE_RELEASE, CLICK_ARRIVED].some(
        (event) => reports.has(`${event}${ON_ITS_WAY}`) && !reports.has(event),
    );

// With the document still there but held by a dialog, the press landed only if the event the dialog
// opened during reached the element: a page that stops that event and opens one has only reacted to it.
function outcomeHeldByDialog(reports: ReadonlySet<string>, sent: PressSent): HitCheckOutcome {
    if (reports.has(CLICK_ARRIVED)) {
        return HitCheckOutcome.Hit;
    }
    if (wasAnEventStoppedOnItsWay(reports)) {
        return HitCheckOutcome.NoClick;
    }
    const wanted = sent === PressSent.Released ? EVENTS_OF_THE_RELEASE : EVENTS_OF_THE_PRESS;
    if (hasAny(reports, wanted)) {
        return HitCheckOutcome.Hit;
    }
    return hasAny(reports, EVENTS_OF_THE_PRESS) ? HitCheckOutcome.NoClick : HitCheckOutcome.None;
}

// With the document gone, the press landed if it reached the element and started the navigation, with
// nothing of it stopped on the way.
function outcomeWithDocumentGone(reports: ReadonlySet<string>): HitCheckOutcome {
    if (reports.has(CLICK_ARRIVED)) {
        return HitCheckOutcome.Hit;
    }
    if (wasAnEventStoppedOnItsWay(reports)) {
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

function decodedCentre(reported: unknown): Point | null {
    if (reported === null) {
        return null;
    }
    const fields: object = typeof reported === "object" ? reported : {};
    const x: unknown = Reflect.get(fields, "x");
    const y: unknown = Reflect.get(fields, "y");
    if (typeof x !== "number" || typeof y !== "number") {
        throw new Error("the browser did not say where the element is");
    }
    return { x, y };
}

// Where the element is once the pointer has arrived, or null when that cannot be anywhere the point is: a
// document that has gone holds no element to press. A dialog stops the press as it would any input.
async function centreOfElementIn(check: PressCheck): Promise<Point | null> {
    const read = await check.read(centreOfTheFirstBox);
    switch (read.kind) {
        case "answered":
            return decodedCentre(read.value);
        case "document-gone":
            return null;
        case "held-by-dialog":
            throw new PageHeldByDialog("reading where the element is");
        case "failed":
            throw new Error(read.detail);
    }
}

// A check nothing will press against. One that a dialog holds stays for the next input to take off, and
// one whose document has gone has gone with it.
async function disarmUnpressed(check: PressCheck): Promise<void> {
    const read = await check.read(disarmUnpressedHitCheck);
    if (read.kind === "failed") {
        throw new Error(read.detail);
    }
}

export type HitChecks<Handle> = {
    // Sends at most one press at the point, around a check armed for it, and says what became of it: none,
    // when the pointer's arrival moved the element, as a person would look and aim again. Any check an
    // earlier press left armed goes first. Throws when the page cannot say: whatever is thrown says
    // nothing of where the press went, so the step fails. Once `hasStepEnded` says the step has ended, no
    // press goes: what is left of it then is only taking the check off.
    around(element: Handle, at: Point, hasStepEnded: HasStepEnded): Promise<HitCheckOutcome>;
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
        async around(element, at, hasStepEnded) {
            await disarmLeftOvers();
            return page.withPressCheck(armHitCheck, element, async (check) => {
                const listening = await check.read(listenForThePress);
                if (listening.kind !== "answered") {
                    throw new Error("the press's check could not listen for it");
                }
                const sent = await page.click(at, () => centreOfElementIn(check), hasStepEnded);
                if (sent === PressSent.NotSent) {
                    await disarmUnpressed(check);
                    return HitCheckOutcome.MovedBeforeThePress;
                }
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
            async hover(at, hasStepEnded) {
                await disarmLeftOvers();
                await page.hover(at, hasStepEnded);
            },
            async fill(element, value, hasStepEnded) {
                await disarmLeftOvers();
                await page.fill(element, value, hasStepEnded);
            },
            async press(element, key, modifiers, hasStepEnded) {
                await disarmLeftOvers();
                await page.press(element, key, modifiers, hasStepEnded);
            },
            async setFiles(element, paths, hasStepEnded) {
                await disarmLeftOvers();
                await page.setFiles(element, paths, hasStepEnded);
            },
            async select(element, option, hasStepEnded) {
                await disarmLeftOvers();
                return page.select(element, option, hasStepEnded);
            },
            async callScript(source, scriptArguments, maximumResultBytes, hasStepEnded) {
                await disarmLeftOvers();
                return page.callScript(source, scriptArguments, maximumResultBytes, hasStepEnded);
            },
        },
        async frame(element) {
            const inner = await page.frame(element);
            return inner === null ? null : { operations: inner, checks: hitChecks(inner) };
        },
    };
}
