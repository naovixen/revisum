// The browser driver ports: what the engine needs from one browser session, split into small
// interfaces. Each driver package implements them; the engine never imports a driver.
import type { Brand } from './brand.ts';
import type { ClipboardPort, ClockPort } from './clock-and-clipboard.ts';
import type { NetworkPort, StoragePort } from './network-and-storage.ts';
import { DriverErrorCode, type DriverError } from './DriverError.ts';
import { ScriptMode, type ResolvedActionStep, type ResolvedDialogStep, type ResolvedDownloadStep, type ResolvedLocator } from './plan.ts';
import type { GuardVerdict } from './policy.ts';
import type { Secret } from './secret.ts';
import { failure, success, type Result } from './result.ts';
import type { AdapterId, BaseUrl, Target } from './target.ts';
import type { SafeText } from './TextOrValue.ts';
import type { StepType } from './StepType.ts';

// Why a probe could not read the page. It is never a count of 0, which a check of absence passes
// on: a page the run cannot read must not look like an empty page. Each value is also the code the
// check fails with.
export const UnreadablePage = {
  ReadFailed: DriverErrorCode.PageUnreadable,
  DialogOpen: DriverErrorCode.DialogOpen,
  // The browser shows its own error page, so the page the check is about never loaded.
  BrowserErrorPage: DriverErrorCode.NavigationFailed,
} as const;
export type UnreadablePage = (typeof UnreadablePage)[keyof typeof UnreadablePage];

// Why a read of the whole page, its title, tree, links, audit or image, gave nothing.
export const PageReadFailureCode = {
  DialogOpen: DriverErrorCode.DialogOpen,
  TargetCrashed: DriverErrorCode.TargetCrashed,
  PageUnreadable: DriverErrorCode.PageUnreadable,
} as const;
export type PageReadFailureCode = (typeof PageReadFailureCode)[keyof typeof PageReadFailureCode];
export type PageReadFailure = { readonly code: PageReadFailureCode; readonly detail: string };

// Why a declared target cannot run. A driver explains a "no"; it never substitutes another target.
// provider-unavailable: the cloud or device provider could not supply the target.
// build-mismatch: the browser build on this machine is not the one the lockfile pins.
export const UnavailableReason = {
  NotDeclared: 'not-declared',
  AdapterNotRegistered: 'adapter-not-registered',
  EngineNotSupported: 'engine-not-supported',
  LaunchFailed: 'launch-failed',
  ProviderUnavailable: 'provider-unavailable',
  BuildMismatch: 'build-mismatch',
} as const;
export type UnavailableReason = (typeof UnavailableReason)[keyof typeof UnavailableReason];
export type Unavailable = { readonly reason: UnavailableReason; readonly detail: string };

// The exact browser build an adapter would run for a target: its version and the executable whose
// sha256 the lockfile pins.
export type BrowserBuild = { readonly version: string; readonly executablePath: string };
// lock-download-failed: the build could not be fetched or is not where it should be.
// lock-offline: fetching the build needs the network, and there is none.
export const BuildFetchFailureCode = {
  LockDownloadFailed: 'lock-download-failed',
  LockOffline: 'lock-offline',
} as const;
export type BuildFetchFailureCode = (typeof BuildFetchFailureCode)[keyof typeof BuildFetchFailureCode];
export const BuildFailureCode = {
  ...BuildFetchFailureCode,
  ...UnavailableReason,
} as const;
export type BuildFailureCode = (typeof BuildFailureCode)[keyof typeof BuildFailureCode];
export type BuildFailure = { readonly code: BuildFailureCode; readonly detail: string };

// A rectangle in css pixels.
export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

// The states an element exposes to assistive technology, read from the browser's accessibility
// tree: aria-selected, aria-expanded, aria-pressed and aria-current, and their native equivalents
// (a selected <option>, the <summary> of an open <details>). Null means the element does not expose
// that state at all, such as a tab whose selection is shown only by a css class, so a check of it
// can never pass. Current is false, not null, on a link or control that carries no aria-current.
export type AccessibleStates = {
  readonly selected: boolean | null;
  readonly expanded: boolean | null;
  readonly pressed: boolean | null;
  readonly current: boolean | null;
};

// A read-only look at the element a locator matches. Only a read of exactly one element holds anything
// of it. A count of 0 or several is not found or ambiguous. A count that is no number means the
// locator could not be looked for at all, so a check of absence cannot pass on it.
export type ElementProbe = ElementsRead | RejectedSelectorProbe | UnreadablePageProbe;

// The browser rejects a CSS selector or XPath expression of the locator: nothing it could ever match,
// so a check fails with selector-invalid rather than waiting.
type RejectedSelectorProbe = { readonly count: typeof DriverErrorCode.SelectorInvalid };
type UnreadablePageProbe = { readonly count: UnreadablePage };

// A count of two or more. TypeScript has no type for "a number other than 1", so this brand is what
// stops a read of one element from posing as a read of no single element, with its states left out.
export type SeveralElements = Brand<number, 'SeveralElements'>;
export const isSeveralElements = (count: number): count is SeveralElements => Number.isInteger(count) && count > 1;

export type ElementsRead = OneElementRead | NoSingleElementRead;

export type OneElementRead = {
  readonly count: 1;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly text: string;
  readonly value: string | null;
  // True when the element, an ancestor or a descendant matches a sensitive (personal data) selector.
  readonly sensitive: boolean;
  readonly box: Box | null;
  readonly states: AccessibleStates;
  // The absolute URL of the link the element is, or is in, resolved against the page's URL; null
  // when it is in no link.
  readonly href: string | null;
  // What the probe was asked to read of the element's DOM, for a DOM check or a remember from an
  // attribute. Present when a read was asked for.
  readonly dom?: DomValue;
};

type NoSingleElementRead = { readonly count: 0 | SeveralElements };

// `count === 1` alone can't narrow a read: the compiler counts a branded number as possibly 1.
export const isOneElementRead = (read: ElementsRead): read is OneElementRead => read.count === 1;

// Why a probe is no read of one element, as the code a check of that element fails with.
export type NoOneElementCode = typeof DriverErrorCode.NotFound | typeof DriverErrorCode.Ambiguous | typeof DriverErrorCode.SelectorInvalid | UnreadablePage;

// The one element a probe read, or why it read none: the one place that tells these apart.
export function oneElementOf(probe: ElementProbe): Result<OneElementRead, NoOneElementCode> {
  if (typeof probe.count === 'string') {
    return failure(probe.count);
  }
  if (isOneElementRead(probe)) {
    return success(probe);
  }
  return failure(probe.count === 0 ? DriverErrorCode.NotFound : DriverErrorCode.Ambiguous);
}

// What a probe reads of the element's DOM besides what it always reads: its class tokens, the
// computed value of one style property (a lowercase css property name), or one attribute's value
// (by its lowercase name).
export const DomReadKind = {
  Classes: 'classes',
  ComputedStyle: 'computedStyle',
  Attribute: 'attribute',
} as const;
export type DomReadKind = (typeof DomReadKind)[keyof typeof DomReadKind];
export type DomRead =
  | { readonly kind: typeof DomReadKind.Classes }
  | { readonly kind: typeof DomReadKind.ComputedStyle; readonly property: string }
  | { readonly kind: typeof DomReadKind.Attribute; readonly name: string };
// What it read: the class tokens in order; the text getComputedStyle gives, such as
// "rgb(220, 38, 38)"; the attribute's value, or null when the element has no such attribute.
export type DomValue =
  | { readonly kind: typeof DomReadKind.Classes; readonly classes: readonly string[] }
  | { readonly kind: typeof DomReadKind.ComputedStyle; readonly value: string }
  | { readonly kind: typeof DomReadKind.Attribute; readonly value: string | null };
// One <meta> tag of the document head: its name or property attribute, and its content.
export type PageMetaTag = { readonly name: string; readonly content: string };
export type PageProbe = {
  readonly url: string;
  readonly title: string;
  // Present when the browser shows its own error page in place of the page: the server refused the
  // connection, the allow-list blocked it, or an HTTP error status came with an empty body. The URL
  // is then the one the browser wanted, so it says nothing about having arrived.
  readonly browserErrorPage?: true;
  // Every <meta> of the document head with a name or property and a content, once per attribute, and
  // the resolved href of <link rel="canonical">, or null when the head has none.
  readonly meta: readonly PageMetaTag[];
  readonly canonicalUrl: string | null;
};

// A file a download step saved. The name is the server's suggested name as text only, with path
// separators and control characters replaced: the driver never stores the file under it. The
// bytes stay in memory for the run's checks; only the name, media type, size and sha256 are kept.
export type DownloadedFile = {
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
};

// How a navigate loads its page. 'disabled' turns script execution off for that page, until the
// next navigate, so checks see what the server sent.
export const NavigateScripts = {
  Enabled: 'enabled',
  Disabled: ScriptMode.Disabled,
} as const;
export type NavigateScripts = (typeof NavigateScripts)[keyof typeof NavigateScripts];
export type NavigateOptions = { readonly scripts: NavigateScripts };

// The element a step's locator resolved to, as the policy gate's runtime guard sees it just before
// the action. A null field is one the page does not show, such as a control with no accessible name.
export type ResolvedElement = {
  readonly role: string | null;
  // The accessible name, as assistive technology would announce it.
  readonly name: string | null;
  readonly box: Box | null;
  // The accessible name of the submit control of the form the element belongs to; null outside a form.
  readonly formSubmitName: string | null;
  // For a link, the absolute URL it leads to.
  readonly linkUrl: string | null;
  // The element's own test id, when it has one.
  readonly testId?: string;
};

// Asked by a driver once it has resolved an action's element, before any input event. On a deny
// the driver performs nothing and returns policy-denied. A click asks again on every attempt, and
// about what the click would activate as well as the element the locator found: the element a
// pointer would hit and the interactive element around it. For a dialog step the element has every
// field null and `dialogText` is the open dialog's text, which decides whether accepting it is
// irreversible; for every other step it is null.
export type ActionGuard = (element: ResolvedElement, dialogText: string | null) => GuardVerdict;

export const Impact = {
  Minor: 'minor',
  Moderate: 'moderate',
  Serious: 'serious',
  Critical: 'critical',
  Unknown: 'unknown',
} as const;
export type Impact = (typeof Impact)[keyof typeof Impact];
export const IMPACTS: readonly Impact[] = Object.values(Impact);
// One accessibility rule that failed on the page, and on how many elements.
export type A11yFinding = { readonly ruleId: string; readonly impact: Impact; readonly elementCount: number };
export type A11yNode = { readonly role: string; readonly name: string; readonly children: readonly A11yNode[] };

// Everything a driver needs to make a session hermetic and repeatable.
export type SessionEnvironment = {
  readonly baseUrl: BaseUrl;
  readonly allowedOrigins: readonly string[];
  readonly seed: number;
  readonly fixedTimeMilliseconds: number;
  readonly sensitiveSelectors: readonly string[];
  readonly timeoutMilliseconds: number;
  // True when the plan advances the clock: the page's timers and animation frames then run only
  // when the clock port moves the run's virtual time. Without it they run in real time, while Date
  // and performance.now() stay frozen.
  readonly virtualTimers?: boolean;
};

export interface PageNavigator {
  navigate(url: string, options: NavigateOptions): Promise<Result<void, DriverError>>;
  page(): Promise<Result<PageProbe, PageReadFailure>>;
}
// What a fill types: literal text, literal lines, or a secret.
export const FillValueKind = {
  Text: 'text',
  Lines: 'lines',
  Secret: 'secret',
} as const;
export type FillValueKind = (typeof FillValueKind)[keyof typeof FillValueKind];
// The secret a fill types. The driver reveals it only at the moment it types it, and never reports
// it back.
export type SecretFill = { readonly kind: typeof FillValueKind.Secret; readonly secret: Secret };
export type FillValue =
  | { readonly kind: typeof FillValueKind.Text; readonly text: SafeText }
  | { readonly kind: typeof FillValueKind.Lines; readonly lines: readonly SafeText[] }
  | SecretFill;
// A fill as a driver performs it.
export type PerformableFill = {
  readonly type: typeof StepType.Fill; readonly locator: ResolvedLocator; readonly value: FillValue;
};
// An action as a driver performs it: every value reference replaced by its text, and a fill of a
// secret holding the secret itself. A download goes through its own port.
export type PerformableAction = Exclude<ResolvedActionStep, { readonly type: typeof StepType.Fill }> | PerformableFill | ResolvedDialogStep;

export interface ActionRunner {
  // The driver resolves the action's element, asks the guard with it, and acts only on an allow; on
  // a deny it sends no input event and returns policy-denied. A dialog step asks the guard with the
  // open dialog's text.
  act(action: PerformableAction, guard: ActionGuard): Promise<Result<void, DriverError>>;
}
export interface Prober {
  // Given a DOM read, the driver reads that too, into the probe's `dom`; given null, it reads no DOM value.
  probe(locator: ResolvedLocator, read: DomRead | null): Promise<ElementProbe>;
}

// One run of a page script, as the engine hands it to a driver. The source is one function
// expression, from a declared file or the plan, passed unchanged: the driver never builds it from
// plan values. The driver calls the function once, in the main world of the document, with one
// argument: an object holding the named arguments as JSON values. It may return a promise, which
// is awaited. Arguments are never secrets.
export type PageScriptCall = {
  readonly source: string;
  readonly arguments: Readonly<Record<string, string | number | boolean>>;
  // Enforced by the driver in real time: past it, the step fails with script-timeout.
  readonly timeoutMilliseconds: number;
  // The driver may stop reading the result text once it is longer than this many bytes: the
  // engine refuses any text over it with script-result-too-large all the same.
  readonly maximumResultBytes: number;
};
export interface Camera {
  // PNG bytes of the viewport, with every element matching `mask` painted solid black, so
  // personal data never reaches an image.
  screenshot(mask: readonly string[]): Promise<Result<Uint8Array, PageReadFailure>>;
  // The same, with every element each of `fields` finds painted black too: the fields a secret was
  // typed into, which no selector need match. A field that finds nothing, in this document or one
  // it is framed in, gives not-found and no image, since what it holds may still be on screen; unless
  // the element typed into has gone and no field holds what `holdsSecret` says is a secret. A dialog
  // holding the page gives dialog-open, and a page that does not answer gives timeout, since neither is
  // a field that cannot be hidden: only not-found means that. It fails too as a read of the page does.
  screenshotHidingFields(mask: readonly string[], fields: readonly ResolvedLocator[], holdsSecret: (text: string) => boolean): Promise<Result<Uint8Array, DriverError>>;
}
export interface Auditor {
  audit(): Promise<Result<readonly A11yFinding[], PageReadFailure>>;
  accessibilitySnapshot(): Promise<Result<A11yNode, PageReadFailure>>;
}

// The ports one document of a session's page offers: the top document, or an iframe's document
// inside it. A step acts and checks through them.
export interface DocumentSession extends PageNavigator, ActionRunner, Prober, Camera, Auditor {
  // The document of the one iframe the locator finds, waited for as an action waits for its
  // element. Steps given to it act and check inside that frame only.
  frame(locator: ResolvedLocator): Promise<Result<DocumentSession, DriverError>>;
  // True once the page's renderer or browser has died, or the connection to it has closed. A failed
  // read of the page says target-crashed by itself. This is for what no failure says: a read that
  // succeeded on a page dying as it answered, a probe (which has no count for a crash), and a throw
  // from anything else. A check on a crashed page then fails with target-crashed rather than waiting
  // out its timeout, whatever its last read saw.
  crashed(): boolean;
  // How many popups, second pages and downloads no step asked for the page has started so far. One
  // that starts during a step fails it with unsupported-step, whatever the step was doing.
  unsupportedOpenings(): number;
  // Clicks the step's element, asking the guard first as a click does, and waits for exactly one
  // download to start within the step timeout and to finish. A click that starts none fails with
  // no-download; a file over maximumBytes is cancelled, its partial bytes deleted, and fails with
  // download-too-large; a popup the click opens fails with unsupported-step.
  download(step: ResolvedDownloadStep, maximumBytes: number, guard: ActionGuard): Promise<Result<DownloadedFile, DriverError>>;
  // Runs a page script in this document and gives its result written as JSON text in the page.
  // The text is outside data: the engine decodes it under its own size and depth limits and reads
  // only the declared fields. A throw or a rejection is script-failed, a value JSON cannot write
  // (undefined, a function, a cycle) is script-result-invalid, and a script that does not settle
  // in time is script-timeout.
  runScript(call: PageScriptCall): Promise<Result<string, DriverError>>;
  // The absolute URLs of this document's links (a and area elements with an href), in document
  // order, as the browser resolves them. A read only: nothing on the page is touched.
  linkTargets(): Promise<Result<readonly string[], PageReadFailure>>;
}

// A second tab of a session. Steps run in its document as in any other; it opens no tab of its own,
// since a plan opens tabs only at its top level.
export interface SessionTab extends DocumentSession {
  // Closes only the tab. It never rejects, whatever state the tab is in, closing again and closing
  // after the session has closed included: what went wrong closing a tab is reported by the session's
  // close.
  close(): Promise<void>;
}

// What a session has noted about its requests and connections. Each record is what it says, or why
// it could not say: an empty list means nothing was noted, never that the record went unread.
export type SessionRecords = {
  // Origins of the requests that were refused and seen by the browser or the proxy, as evidence that
  // the run stayed hermetic. Not every attempt: what never reaches either, such as WebRTC's UDP, sends
  // nothing and leaves nothing to show.
  readonly blockedOrigins: Result<readonly string[], string>;
  // Declared origins the session could not connect to, each with what to tell whoever is running. A
  // machine's network says nothing about the app, so these go to the run's log and stay out of the
  // result and its hash.
  readonly connectionFailures: Result<readonly { readonly origin: string; readonly message: string }[], string>;
  // Why the browser refused each of the driver's decisions on the session's requests, and each request
  // it held that the driver could not read to decide on. A refused request stays held, so nothing that
  // happens after it says anything about the app, and a run with one cannot pass. A page that gave up
  // on a request, or a tab that has gone, is no refusal. The text goes to the run's log and stays out
  // of the result and its hash.
  readonly refusedRequestDecisions: Result<readonly string[], string>;
};

// What a session leaves once it has closed: its records, now complete, and what went wrong closing
// it. Only close gives one.
export type ClosedSession = SessionRecords & {
  // What stopped part of the close, such as a browser profile the system still holds; null when all
  // of it closed. The records are read all the same, once everything the close could end has ended.
  readonly closeFailure: string | null;
};

// One open browser session: every driver port together.
export interface Session extends DocumentSession {
  readonly browser: { readonly name: string; readonly version: string };
  // True once the browser has refused a decision of the driver's on one of the session's requests, or
  // held one the driver could not read, so far: what the session's records will list. It only reads
  // what the session already knows, so it never throws, a closed session included.
  isRequestHeld(): boolean;
  // What the session has noted so far. Incomplete until it has closed, so a result reads what close
  // gives, and reads this only for a session whose close did not finish.
  recordsSoFar(): SessionRecords;
  // Ends the session; every process it started exits. It never rejects: what went wrong closing is in
  // the record it gives. Closing again gives the same record and does nothing more.
  close(): Promise<ClosedSession>;
  // Opens the URL in a new tab of the session's own browser context, so it shares cookies and
  // storage, with the same environment, egress control and determinism script as the first tab.
  // The tab's blocked origins join this session's.
  newTab(url: string): Promise<Result<SessionTab, DriverError>>;
  // Stubs and request checks for the whole browser context, so they reach every tab and frame.
  readonly network: NetworkPort;
  // Local and session storage of the session's page.
  readonly storage: StoragePort;
  // The run's virtual clock, shared by every tab and frame.
  readonly clock: ClockPort;
  // The run's own in-memory clipboard.
  readonly clipboard: ClipboardPort;
}

export type AdapterInfo = {
  readonly id: string;
  readonly version: string;
  readonly protocol: string;
  // Inputs this adapter cannot pin, such as a browser it does not install itself. The run manifest
  // lists them under nonHermeticInputs.
  readonly cannotPin?: readonly string[];
};

export interface BrowserDriver {
  readonly info: AdapterInfo;
  // A pure capability check. It says yes or explains no; it never substitutes.
  supports(target: Target): Result<true, Unavailable>;
  open(target: Target, environment: SessionEnvironment): Promise<Result<Session, Unavailable>>;
  // The browser build `open` would launch for the target, without launching it, so it can be
  // pinned by hash and checked before a run. An adapter without it cannot pin its browser.
  build?(target: Target): Promise<Result<BrowserBuild, BuildFailure>>;
}

// The adapters a run may use, by id. `find` gives the one a target names, or null: core never
// looks for another adapter instead.
export interface AdapterRegistry {
  all(): readonly BrowserDriver[];
  find(id: AdapterId): BrowserDriver | null;
}
