// The seam each browser protocol implements once. buildSession (browser-session.ts) turns a
// PageOperations into a Session, so auto-waiting, probes and audits behave the same on every
// protocol. One PageOperations serves one document: the page's top document, or an iframe's.
import type {
  A11yNode, BrowserDriver, BrowserRequestRecord, DownloadedFile, DriverError, Key, Result, Session, SessionEnvironment, Target, Unavailable,
} from '@revisum/contracts';
import type { PressCheck, PressSent } from './HitChecks.ts';
import type { HeldModifierKey } from './modifier-keys.ts';

export type Point = { readonly x: number; readonly y: number };
type ProtocolId = 'cdp' | 'webdriver-bidi' | 'webdriver-classic';

// An element handle wrapped so that it can never be mistaken for a string argument.
type ElementArgument<Handle> = { readonly element: Handle };
export type PageArgument<Handle> = string | number | boolean | readonly string[] | ElementArgument<Handle>;
// A self-contained page function, sent with toString().
export type PageFunction = (...inputs: never[]) => unknown;

// What a session needs from one page, in protocol terms. Handle is the protocol's element handle.
export interface PageOperations<Handle> {
  readonly protocol: ProtocolId;
  // Where accessibilityTree() comes from, for notes in the manifest.
  readonly accessibilityTreeSource: 'browser' | 'in-page-approximation';
  // With scripts 'disabled', the page loads with script execution off until the next navigate.
  // Reads go through a script world of the driver's own either way, which the page's scripts can
  // neither see nor patch, and where the driver's own reads still run.
  navigate(url: string, timeoutMilliseconds: number, scripts: 'enabled' | 'disabled'): Promise<void>;
  // Calls a page function that returns a string (JSON where structured). Promises are awaited. Rejects
  // when it gives anything else.
  callForString(pageFunction: PageFunction, inputs: readonly PageArgument<Handle>[]): Promise<string>;
  // Resolves two frames of this document later, which is how long whatever it just started takes to
  // reach the browser, or as soon as no more frames can come: its document has been replaced or
  // closed, its page has died, or a dialog holds its page. Any other failure rejects.
  twoFramesLater(): Promise<void>;
  // Calls a page function that returns Element[], and returns their handles.
  callForElements(pageFunction: PageFunction, inputs: readonly PageArgument<Handle>[]): Promise<Handle[]>;
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
  // main world. Nothing else comes back. True only when the property is false or absent. A page that hangs
  // in its code holds this up, and a dialog its code opens rejects this with PageHeldByDialog.
  isCustomElementEnabled(element: Handle): Promise<boolean>;
  // A PNG of the viewport.
  screenshotPng(): Promise<Uint8Array>;
  // The URL the browser could not show, while it shows its own error page in its place, such as
  // for an HTTP error status with an empty body; null otherwise.
  unreachableUrl(): Promise<string | null>;
  // Calls a page function that returns a string in the page's own main world, where the page's scripts
  // run and can answer whatever they like, so what it gives is never evidence of what is on the page.
  callForStringInMainWorld(pageFunction: PageFunction, inputs: readonly PageArgument<Handle>[]): Promise<string>;
}

// The input a session sends a document. It is apart from PageOperations so that a session can reach it
// only through hitChecks (HitChecks.ts), and a new kind of input does not compile until it goes there.
export interface PageInput<Handle> {
  // Points are in this document's viewport. Says how far it got before a dialog stopped it.
  click(element: Handle, at: Point): Promise<PressSent>;
  hover(at: Point): Promise<void>;
  // Inserts the text as typed text, line feeds included, with no key press for them.
  fill(element: Handle, value: string): Promise<void>;
  // Holds the modifier keys down in order, presses the key, then releases them in reverse.
  press(element: Handle, key: Key, modifiers: readonly HeldModifierKey[]): Promise<void>;
  // Gives a file input these files, by absolute path, firing its input and change events.
  setFiles(element: Handle, paths: readonly string[]): Promise<void>;
  // Chooses the option of a select whose visible text, or else whose value, is `option`, firing the
  // events a person's choice fires.
  select(element: Handle, option: string): Promise<SelectOutcome>;
  // Calls a page script's source, one function expression, once in this document's main world
  // with one argument, the arguments object; awaits it and writes its result as JSON text in the
  // page (scriptResultText in in-page.ts). It never times out by itself: the session races it.
  callScript(source: string, scriptArguments: Readonly<Record<string, string | number | boolean>>, maximumResultBytes: number): Promise<ScriptCallOutcome>;
}

// What enabledState (in-page.ts) says of an element.
export const ElementEnabledState = { Enabled: 'enabled', Disabled: 'disabled', CustomElement: 'custom-element' } as const;
export type ElementEnabledState = (typeof ElementEnabledState)[keyof typeof ElementEnabledState];

export const SelectOutcome = { Selected: 'selected', NoOption: 'no-option', NotASelect: 'not-a-select' } as const;
export type SelectOutcome = (typeof SelectOutcome)[keyof typeof SelectOutcome];

// One document with its input, which only hitChecks (HitChecks.ts) is given. It also gives the document
// of an iframe, input included, so that document's input stays out of a session's reach too.
export type PageWithInput<Handle> = PageOperations<Handle> & PageInput<Handle> & {
  // The document of the iframe element; null when the element is not an iframe whose document this
  // protocol can reach.
  frame(element: Handle): Promise<PageWithInput<Handle> | null>;
  // Calls `arm` with the element, the name to report by and this press's id, in a script world of the
  // driver's own, keeps the check it returns for `use` to read, and lets it go as `use` ends. A check
  // that cannot be let go, because a dialog holds the page, stays for the next call below to take off.
  withPressCheck<Value>(arm: PageFunction, element: Handle, use: (check: PressCheck) => Promise<Value>): Promise<Value>;
  // Calls a page function that says whether it took something off, in that script world of this document
  // and of every document framed in it, skipping any that has gone. The world is the document's, so any
  // PageOperations of the document reaches what an earlier call left there. Rejects with
  // PageHeldByDialog while a dialog holds the page, or with why it could not be called.
  callInEveryFramedDocumentOutOfReach(pageFunction: PageFunction): Promise<void>;
};

// How one call of a page script ended: with its result as JSON text, with a throw or a rejection,
// or with a result JSON cannot write.
export type ScriptCallOutcome = { readonly kind: 'result'; readonly text: string } | { readonly kind: 'threw' } | { readonly kind: 'not-json' };

export type RoleAndName = { readonly role: string | null; readonly name: string | null };
export type ExposedStates = { readonly selected: boolean | null; readonly expanded: boolean | null; readonly pressed: boolean | null };

// The browser's downloads for one session and its tabs: saved into a folder of the session's own,
// and refused at every other time.
export interface DownloadCapture {
  // Holds the session's downloads for one step. Nothing is saved or claimed until expectFromPress.
  arm(): ArmedDownload;
}
// What a download step knows about the press it is about to send.
export type DownloadPress = {
  // The frame the press acts in. A file that begins in another frame is not the press's.
  readonly frameId: string;
  // False when the press can start nothing, so no file can be the press's.
  readonly canStartFile: boolean;
};
export interface ArmedDownload {
  // Called just before the press: lets the browser save the next download of the press's frame,
  // and claims it for the caller. A download that began earlier is no download of the press.
  expectFromPress(press: DownloadPress): Promise<void>;
  // Waits up to `beginTimeoutMilliseconds` for the claimed download to start (no-download), then
  // for its last byte. A file over `maximumBytes` is cancelled and its bytes deleted
  // (download-too-large). Stops waiting as soon as `shouldStopWaiting` says the step is over.
  finish(maximumBytes: number, beginTimeoutMilliseconds: number, shouldStopWaiting: () => boolean): Promise<Result<DownloadedFile, DriverError>>;
  // Refuses downloads again. Unless `keep` is true and the file finished, the download is
  // cancelled and its bytes deleted; a kept file stays until the session closes.
  release(keep: boolean): Promise<void>;
}

// What a session learns from the browser about its page outside any one command.
export interface PageEvents {
  // True once the page's renderer or browser has died, its target has closed, or the connection to
  // the browser has closed.
  crashed(): boolean;
  // The text of the dialog the page has open, or null when none is open.
  openDialog(): string | null;
  // Accepts or dismisses the open dialog.
  answerDialog(accept: boolean): Promise<void>;
  // Resolves once the top document is not on its way to another, or a dialog or a crash has stopped
  // it from getting there: at once when it is not.
  navigationEnded(): Promise<void>;
  // What the browser refused of the driver's decisions on the session's requests, in any of its tabs,
  // each with its reason, and each request it held that the driver could not read to decide on.
  refusedRequestDecisions(): readonly string[];
  // Grows with each popup, second page and download the page starts. Each is closed or cancelled as
  // soon as it starts. Only growth means anything: a download counts as its file is asked for, and
  // again as it begins.
  unsupportedOpenings(): number;
}

export type Actionability = {
  readonly attached: boolean;
  readonly visible: boolean;
  readonly stable: boolean;
  readonly enabled: boolean;
  readonly receivesEvents: boolean;
  readonly centre: Point | null;
};

// A Session plus what evidence and measurement need from the own drivers.
export interface DriverSession extends Session {
  // The root process the driver started.
  readonly processId: number;
  // Evaluates a self-contained page function that returns a string (tests and evidence only).
  evaluate(pageFunction: PageFunction, inputs?: readonly (string | number | boolean)[]): Promise<string>;
  // Every request the session's page, workers and popups sent, by origin and channel, in order.
  // Joined with the egress proxy's decisions, they make the run's egress events.
  egressRecords(): readonly BrowserRequestRecord[];
}

export interface OwnBrowserDriver extends BrowserDriver {
  open(target: Target, environment: SessionEnvironment): Promise<Result<DriverSession, Unavailable>>;
}
