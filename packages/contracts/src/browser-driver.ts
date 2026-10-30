// The browser driver ports: what the engine needs from one browser session, split into small
// interfaces. Each driver package implements them; the engine never imports a driver.
// See docs/specs/SPEC-06-cdp-driver.md and docs/specs/SPEC-27-shared-types-and-events.md.
import type { DriverFeature } from './literal-steps.ts';
import type { NetworkPort, StoragePort } from './network-and-storage.ts';
import type { ActionStep, DownloadStep, Locator, ResolvedLocator } from './plan.ts';
import type { GuardVerdict } from './policy.ts';
import type { Secret } from './secret.ts';
import type { Result } from './result.ts';
import type { AdapterId, Target } from './target.ts';

// policy-denied: the policy gate's runtime guard refused the action, so no input event was sent.
// no-download: a download step's click started no download within the step timeout.
// download-too-large: the file grew past the project's maximumDownloadBytes; its partial bytes are deleted.
// storage-origin-mismatch: a storage write's page is not on the entry's declared origin, so nothing was written.
// clock-runaway: one clock advance would fire more timer callbacks than the project's maximumTimersPerAdvance.
// clipboard-unavailable: the browser cannot keep the clipboard in its own memory, so it is never read.
// target-crashed: the page's renderer died, or its target closed, while the step ran. The step
// fails, the rest of the run is skipped, and close() still ends every process.
// unsupported-step: the driver does not perform this kind of step, or the step made the page open
// a popup or a second page, or start a download. The popup is closed and the download cancelled,
// with nothing of it kept, so the step never passes with a partial result.
// assertion-failed: a dialog step's expected text is not the open dialog's text, so nothing
// answered the dialog.
export type DriverErrorCode =
  | 'not-found' | 'ambiguous' | 'not-actionable' | 'timeout' | 'navigation-failed' | 'policy-denied'
  | 'no-download' | 'download-too-large' | 'storage-origin-mismatch' | 'clock-runaway' | 'clipboard-unavailable'
  | 'target-crashed' | 'unsupported-step' | 'assertion-failed';
export type DriverError = { readonly code: DriverErrorCode; readonly detail: string };

// Why a declared target cannot run. A driver explains a "no"; it never substitutes another target.
// provider-unavailable: the cloud or device provider could not supply the target.
// build-mismatch: the browser build on this machine is not the one the lockfile pins.
export type UnavailableReason =
  | 'not-declared' | 'adapter-not-registered' | 'engine-not-supported' | 'device-not-supported' | 'launch-failed'
  | 'provider-unavailable' | 'build-mismatch';
export type Unavailable = { readonly reason: UnavailableReason; readonly detail: string };

// The exact browser build an adapter would run for a target: its version and the executable whose
// sha256 the lockfile pins.
export type BrowserBuild = { readonly version: string; readonly executablePath: string };
// lock-download-failed: the build could not be fetched or is not where it should be.
// lock-offline: fetching the build needs the network, and there is none.
export type BuildFailureCode = 'lock-download-failed' | 'lock-offline' | UnavailableReason;
export type BuildFailure = { readonly code: BuildFailureCode; readonly detail: string };

// A rectangle in CSS pixels.
export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

// The states an element exposes to assistive technology, read from the browser's accessibility
// tree: aria-selected, aria-expanded, aria-pressed and aria-current, and their native equivalents
// (a selected <option>, the <summary> of an open <details>). Null means the element does not expose
// that state at all, such as a tab whose selection is shown only by a CSS class, so a check of it
// can never pass. Current is false, not null, on a link or control that carries no aria-current.
export type AccessibleStates = {
  readonly selected: boolean | null;
  readonly expanded: boolean | null;
  readonly pressed: boolean | null;
  readonly current: boolean | null;
};

// A read-only look at the element a locator matches. A count other than 1 means not found or ambiguous.
export type ElementProbe = {
  readonly count: number;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly text: string;
  readonly value: string | null;
  // True when the element, an ancestor or a descendant matches a sensitive (personal data) selector.
  readonly sensitive: boolean;
  readonly box: Box | null;
  // Present when the driver reads accessibility states (the pageStates feature).
  readonly states?: AccessibleStates;
  // The absolute URL of the link the element is, or is in, resolved against the page's URL; null
  // when it is in no link. Present when the driver reads link targets (the linkTargets feature).
  readonly href?: string | null;
};
// One <meta> tag of the document head: its name or property attribute, and its content.
export type PageMetaTag = { readonly name: string; readonly content: string };
export type PageProbe = {
  readonly url: string;
  readonly title: string;
  // Present when the driver reads the document head (the pageMetadata feature): every <meta> with a
  // name or property and a content, once per attribute, and the resolved href of
  // <link rel="canonical">, or null when the head has none.
  readonly meta?: readonly PageMetaTag[];
  readonly canonicalUrl?: string | null;
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
// next navigate, so checks see what the server sent (the scriptsDisabled feature).
export type NavigateOptions = { readonly scripts: 'enabled' | 'disabled' };

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
// the driver performs nothing and returns policy-denied. For a dialog step the element has every
// field null and `dialogText` is the open dialog's text, which decides whether accepting it is
// irreversible; for every other step it is null.
export type ActionGuard = (element: ResolvedElement, dialogText: string | null) => GuardVerdict;

export const IMPACTS = ['minor', 'moderate', 'serious', 'critical', 'unknown'] as const;
export type Impact = (typeof IMPACTS)[number];
// One accessibility rule that failed on the page, and on how many elements.
export type A11yFinding = { readonly ruleId: string; readonly impact: Impact; readonly elementCount: number };
export type A11yNode = { readonly role: string; readonly name: string; readonly children: readonly A11yNode[] };

// Everything a driver needs to make a session hermetic and repeatable.
export type SessionEnvironment = {
  readonly baseUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly seed: number;
  readonly fixedTimeMilliseconds: number;
  readonly sensitiveSelectors: readonly string[];
  readonly timeoutMilliseconds: number;
};

export interface PageNavigator {
  // Without options, scripts run as usual.
  navigate(url: string, options?: NavigateOptions): Promise<Result<void, DriverError>>;
  page(): Promise<PageProbe>;
}
export interface ActionRunner {
  // Given a guard, the driver resolves the step's element, asks the guard with it, and acts only
  // on an allow; on a deny it sends no input event and returns policy-denied. The engine passes a
  // guard with every action. A dialog step asks the guard with the open dialog's text.
  // A driver that does not perform a kind of step returns unsupported-step, with nothing sent.
  // For a fill whose value is a secret reference, the engine passes the resolved secret; the driver
  // reveals it only at the moment it types, and never reports it back. The engine replaces value
  // references before it acts; a driver refuses any step that still holds one.
  act(step: ActionStep, guard?: ActionGuard, secret?: Secret): Promise<Result<void, DriverError>>;
}
export interface Prober {
  // The engine replaces a locator's value references with their text before it probes.
  probe(locator: Locator): Promise<ElementProbe>;
}
export interface Camera {
  // PNG bytes of the viewport, with every element matching `mask` painted solid black, so
  // personal data never reaches an image. See docs/specs/SPEC-09-privacy-masking.md.
  screenshot(mask: readonly string[]): Promise<Uint8Array>;
}
export interface Auditor {
  audit(): Promise<readonly A11yFinding[]>;
  accessibilitySnapshot(): Promise<A11yNode>;
}

// The ports one document of a session's page offers: the top document, or an iframe's document
// inside it. A step acts and checks through them.
export interface DocumentSession extends PageNavigator, ActionRunner, Prober, Camera, Auditor {
  // The document of the one iframe the locator finds, waited for as an action waits for its
  // element. Steps given to it act and check inside that frame only. A driver without it does not
  // run frame steps, and the run fails them with unsupported-step.
  frame?(locator: ResolvedLocator): Promise<Result<DocumentSession, DriverError>>;
  // True once the page's renderer has died. A check waiting on a crashed page then fails with
  // target-crashed rather than waiting out its timeout. A driver without it never reports a crash.
  crashed?(): boolean;
  // Clicks the step's element, asking the guard first as a click does, and waits for exactly one
  // download to start within the step timeout and to finish. A click that starts none fails with
  // no-download; a file over maximumBytes is cancelled, its partial bytes deleted, and fails with
  // download-too-large; a popup the click opens fails with unsupported-step. A driver without it
  // does not perform downloads (the downloads feature).
  download?(step: DownloadStep, maximumBytes: number, guard?: ActionGuard): Promise<Result<DownloadedFile, DriverError>>;
}

// One open browser session: every driver port together.
export interface Session extends DocumentSession {
  readonly browser: { readonly name: string; readonly version: string };
  // Origins of the requests the session refused, as evidence that the run stayed hermetic.
  blockedOrigins(): readonly string[];
  // Ends the session; every process it started exits.
  close(): Promise<void>;
  // Opens the URL in a new tab of the session's own browser context, so it shares cookies and
  // storage, with the same environment, egress control and determinism script as the first tab.
  // The tab's close() closes only the tab; its blocked origins join this session's. A driver
  // without it does not open tabs (the newTabs feature).
  newTab?(url: string): Promise<Result<Session, DriverError>>;
  // Stubs and request checks for the whole browser context, so they reach every tab and frame. A
  // driver without it declares neither networkStubs nor requestChecks.
  readonly network?: NetworkPort;
  // Local and session storage of the session's page. A driver without it does not declare storage.
  readonly storage?: StoragePort;
}

export type AdapterInfo = {
  readonly id: string;
  readonly version: string;
  readonly protocol: string;
  // Inputs this adapter cannot pin, such as a browser it does not install itself. The run manifest
  // lists them under nonHermeticInputs.
  readonly cannotPin?: readonly string[];
  // The optional plan features this adapter performs (DRIVER_FEATURES), such as positions and key
  // chords. The run refuses a step that needs one it does not list with unsupported-step, before
  // anything of the step reaches the adapter. Absent means none.
  readonly performs?: readonly DriverFeature[];
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
