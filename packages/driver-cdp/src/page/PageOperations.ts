// The seam each browser protocol implements once. buildSession (session/BuildSession.ts) turns a
// PageOperations into a Session, so auto-waiting, probes and audits behave the same on every
// protocol. One PageOperations serves one document: the page's top document, or an iframe's.
import type { A11yNode, Key } from "@revisum/contracts";
import type { HeldModifierKey } from "./input/HeldModifierKeys.ts";
import type { PageFunction } from "./PageFunction.ts";
import type { PressCheck, PressSent } from "./checks/PressCheck.ts";

export type Point = { readonly x: number; readonly y: number };

// An element handle wrapped so that it can never be mistaken for a string argument.
type ElementArgument<Handle> = { readonly element: Handle };
export type PageArgument<Handle> =
    string | number | boolean | readonly string[] | ElementArgument<Handle>;

// What a session needs from one page, in protocol terms. Handle is the protocol's element handle.
export interface PageOperations<Handle> {
    // With scripts 'disabled', the page loads with script execution off until the next navigate.
    // Reads go through a script world of the driver's own either way, which the page's scripts can
    // neither see nor patch, and where the driver's own reads still run.
    navigate(
        url: string,
        timeoutMilliseconds: number,
        scripts: "enabled" | "disabled",
    ): Promise<void>;
    // Calls a page function that returns a string (JSON where structured). Promises are awaited. Rejects
    // when it gives anything else.
    callForString(
        pageFunction: PageFunction,
        inputs: readonly PageArgument<Handle>[],
    ): Promise<string>;
    // Resolves two frames of this document later, which is how long whatever it just started takes to
    // reach the browser, or as soon as no more frames can come: its document has been replaced or
    // closed, its page has died, or a dialog holds its page. Any other failure rejects.
    twoFramesLater(): Promise<void>;
    // Calls a page function that returns Element[], and returns their handles.
    callForElements(
        pageFunction: PageFunction,
        inputs: readonly PageArgument<Handle>[],
    ): Promise<Handle[]>;
    // Elements with this role and exact accessible name, found by the browser's own accessibility engine.
    byRole(role: string, name: string): Promise<Handle[]>;
    accessibilityTree(): Promise<A11yNode>;
    // The element's role and accessible name, as the browser's accessibility engine computes them;
    // null for one it does not expose.
    roleAndName(element: Handle): Promise<RoleAndName>;
    // The selected, expanded and pressed states the browser's accessibility engine exposes for the
    // element; null for each it does not expose.
    exposedStates(element: Handle): Promise<ExposedStates>;
    // True when the element is no longer in any document on screen: removed from its own, or its
    // document was replaced or closed, or its page died. Rejects when the page cannot say.
    isElementGone(element: Handle): Promise<boolean>;
    // The browser's id for this document's frame, as it names the frame a download began in.
    frameId(): Promise<string>;
    // False when a press at the point can start nothing: neither it nor what holds it has a listener
    // for a pointer's events or does anything by itself when pressed.
    canPressStartAnything(element: Handle, at: Point): Promise<boolean>;
    // What a custom element's own disabled property says, read by running the page's code in the page's
    // main world. Nothing else comes back. True only when the property is false, undefined or absent. A page that hangs
    // in its code holds this up, and a dialog its code opens rejects this with PageHeldByDialog.
    isCustomElementEnabled(element: Handle): Promise<boolean>;
    // A PNG of the viewport.
    screenshotPng(): Promise<Uint8Array>;
    // The URL the browser could not show, while it shows its own error page in its place, such as
    // for an HTTP error status with an empty body; null otherwise.
    unreachableUrl(): Promise<string | null>;
    // Calls a page function that returns a string in the page's own main world, where the page's scripts
    // run and can answer whatever they like, so what it gives is never evidence of what is on the page.
    callForStringInMainWorld(
        pageFunction: PageFunction,
        inputs: readonly PageArgument<Handle>[],
    ): Promise<string>;
}

// The input a session sends a document. It is apart from PageOperations so that a session can reach it
// only through hitChecks (HitChecks.ts), and a new kind of input does not compile until it goes there.
// Every input is given `hasStepEnded`, and asks it just before each command it sends the page, in the
// same turn as the send: once it says the step has ended, the input sends nothing more and rejects with
// StepHasEnded, so no part of a step that has failed with its timeout reaches the page afterwards.
export interface PageInput<Handle> {
    // Moves the pointer to the point, in this document's viewport, then presses and releases there unless
    // the aim has gone stale: `centreOfElementNow`, or where this document sits in the top viewport, no longer
    // agrees with the point. Says how far it got before a dialog or a stale aim stopped it.
    click(
        at: Point,
        centreOfElementNow: () => Promise<Point | null>,
        hasStepEnded: HasStepEnded,
    ): Promise<PressSent>;
    hover(at: Point, hasStepEnded: HasStepEnded): Promise<void>;
    // Inserts the text as typed text, line feeds included, with no key press for them.
    fill(element: Handle, value: string, hasStepEnded: HasStepEnded): Promise<void>;
    // Holds the modifier keys down in order, presses the key, then releases them in reverse.
    press(
        element: Handle,
        key: Key,
        modifiers: readonly HeldModifierKey[],
        hasStepEnded: HasStepEnded,
    ): Promise<void>;
    // Gives a file input these files, by absolute path, firing its input and change events.
    setFiles(element: Handle, paths: readonly string[], hasStepEnded: HasStepEnded): Promise<void>;
    // Chooses the option of a select whose visible text, or else whose value, is `option`, firing the
    // events a person's choice fires.
    select(element: Handle, option: string, hasStepEnded: HasStepEnded): Promise<SelectOutcome>;
    // Calls a page script's source, one function expression, once in this document's main world
    // with one argument, the arguments object; awaits it and writes its result as JSON text in the
    // page (in-page/ScriptResultText.ts). It never times out by itself: the session races it.
    callScript(
        source: string,
        scriptArguments: Readonly<Record<string, string | number | boolean>>,
        maximumResultBytes: number,
        hasStepEnded: HasStepEnded,
    ): Promise<ScriptCallOutcome>;
}

// Says whether the step an input belongs to has ended, which its timer decides.
export type HasStepEnded = () => boolean;

// What enabledState (in-page/EnabledState.ts) says of an element.
export const ElementEnabledState = {
    Enabled: "enabled",
    Disabled: "disabled",
    CustomElement: "custom-element",
} as const;
export type ElementEnabledState = (typeof ElementEnabledState)[keyof typeof ElementEnabledState];

export const SelectOutcome = {
    Selected: "selected",
    NoOption: "no-option",
    NotASelect: "not-a-select",
} as const;
export type SelectOutcome = (typeof SelectOutcome)[keyof typeof SelectOutcome];

// One document with its input, which only hitChecks (HitChecks.ts) is given. It also gives the document
// of an iframe, input included, so that document's input stays out of a session's reach too.
export type PageWithInput<Handle> = PageOperations<Handle> &
    PageInput<Handle> & {
        // The document of the iframe element; null when the element is not an iframe whose document this
        // protocol can reach.
        frame(element: Handle): Promise<PageWithInput<Handle> | null>;
        // Calls `arm` with the element, the name to report by and this press's id, in a script world of the
        // driver's own, keeps the check it returns for `use` to read, and lets it go as `use` ends. A check
        // that cannot be let go, because a dialog holds the page, stays for the next call below to take off.
        withPressCheck<Value>(
            arm: PageFunction,
            element: Handle,
            use: (check: PressCheck) => Promise<Value>,
        ): Promise<Value>;
        // Calls a page function that says whether it took something off, in that script world of this document
        // and of every document framed in it, skipping any that has gone. The world is the document's, so any
        // PageOperations of the document reaches what an earlier call left there. Rejects with
        // PageHeldByDialog while a dialog holds the page, or with why it could not be called.
        callInEveryFramedDocumentOutOfReach(pageFunction: PageFunction): Promise<void>;
    };

// How one call of a page script ended: with its result as JSON text, with a throw or a rejection,
// or with a result JSON cannot write.
export type ScriptCallOutcome =
    | { readonly kind: "result"; readonly text: string }
    | { readonly kind: "threw" }
    | { readonly kind: "not-json" };

export type RoleAndName = { readonly role: string | null; readonly name: string | null };
export type ExposedStates = {
    readonly selected: boolean | null;
    readonly expanded: boolean | null;
    readonly pressed: boolean | null;
};

export type Actionability = {
    readonly attached: boolean;
    readonly visible: boolean;
    readonly stable: boolean;
    readonly enabled: boolean;
    readonly receivesEvents: boolean;
    readonly centre: Point | null;
};
