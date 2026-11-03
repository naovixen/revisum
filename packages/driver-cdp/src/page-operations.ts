// The seam each browser protocol implements once. buildSession (browser-session.ts) turns a
// PageOperations into a Session, so auto-waiting, probes and audits behave the same on every
// protocol. One PageOperations serves one document: the page's top document, or an iframe's.
import type {
  A11yNode, BrowserDriver, BrowserRequestRecord, DownloadedFile, DriverError, Key, Result, Session, SessionEnvironment, Target, Unavailable,
} from '@revisum/contracts';
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
  // With scripts 'disabled', the page loads with script execution off until the next navigate,
  // and the page is read through an isolated script world, where the driver's own reads still run.
  navigate(url: string, timeoutMilliseconds: number, scripts: 'enabled' | 'disabled'): Promise<void>;
  // Calls a page function that returns a string (JSON where structured). Promises are awaited.
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
  // document was replaced or closed, or its page died. Throws when the page cannot say.
  isElementGone(element: Handle): Promise<boolean>;
  // The browser's id for this document's frame, as it names the frame a download began in.
  frameId(): Promise<string>;
  // False when a press at the point can start nothing: neither it nor what holds it has a listener
  // for a pointer's events or does anything by itself when pressed.
  canPressStartAnything(element: Handle, at: Point): Promise<boolean>;
  // Points are in this document's viewport.
  click(element: Handle, at: Point): Promise<void>;
  hover(at: Point): Promise<void>;
  // Inserts the text as typed text, line feeds included, with no key press for them.
  fill(element: Handle, value: string): Promise<void>;
  // Holds the modifier keys down in order, presses the key, then releases them in reverse.
  press(element: Handle, key: Key, modifiers: readonly HeldModifierKey[]): Promise<void>;
  // Gives a file input these files, by absolute path, firing its input and change events.
  setFiles(element: Handle, paths: readonly string[]): Promise<void>;
  // The document of the iframe element, as operations of its own; null when the element is not an
  // iframe whose document this protocol can reach.
  frame(element: Handle): Promise<PageOperations<Handle> | null>;
  // A PNG of the viewport.
  screenshotPng(): Promise<Uint8Array>;
  // The URL the browser could not show, while it shows its own error page in its place, such as
  // for an HTTP error status with an empty body; null otherwise.
  unreachableUrl(): Promise<string | null>;
  // Calls a page script's source, one function expression, once in this document's main world
  // with one argument, the arguments object; awaits it and writes its result as JSON text in the
  // page (scriptResultText in in-page.ts). It never times out by itself: the session races it.
  callScript(source: string, scriptArguments: Readonly<Record<string, string | number | boolean>>, maximumResultBytes: number): Promise<ScriptCallOutcome>;
}

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
  // How many popups, second pages and downloads the page has started so far. Each is closed or
  // cancelled as soon as it starts.
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
