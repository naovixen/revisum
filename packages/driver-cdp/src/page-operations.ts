// The seam each browser protocol implements once. buildSession (browser-session.ts) turns a
// PageOperations into a Session, so auto-waiting, probes and audits behave the same on every
// protocol. One PageOperations serves one document: the page's top document, or an iframe's.
import type {
  A11yNode, BrowserDriver, BrowserRequestRecord, DownloadedFile, DriverError, Key, Result, Session, SessionEnvironment, Target, Unavailable,
} from '@revisum/contracts';
import type { HeldModifierKey } from './modifier-keys.ts';
import type { AuditRuleResult } from './page-audit.ts';

export type Point = { readonly x: number; readonly y: number };
export type ProtocolId = 'cdp' | 'webdriver-bidi' | 'webdriver-classic';

// An element handle wrapped so that it can never be mistaken for a string argument.
export type ElementArgument<Handle> = { readonly element: Handle };
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
  // Lets the browser save the next download the session starts, and claims it for the caller.
  arm(): Promise<ArmedDownload>;
}
export interface ArmedDownload {
  // Waits up to `beginTimeoutMilliseconds` for the claimed download to start (no-download), then
  // for its last byte. A file over `maximumBytes` is cancelled and its bytes deleted
  // (download-too-large).
  finish(maximumBytes: number, beginTimeoutMilliseconds: number): Promise<Result<DownloadedFile, DriverError>>;
  // Refuses downloads again. Unless `keep` is true and the file finished, the download is
  // cancelled and its bytes deleted; a kept file stays until the session closes.
  release(keep: boolean): Promise<void>;
}

// What a session learns from the browser about its page outside any one command.
export interface PageEvents {
  // True once the page's renderer has died or its target has closed.
  crashed(): boolean;
  // The text of the dialog the page has open, or null when none is open.
  openDialog(): string | null;
  // Accepts or dismisses the open dialog.
  answerDialog(accept: boolean): Promise<void>;
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
  auditDetailed(): Promise<readonly AuditRuleResult[]>;
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
