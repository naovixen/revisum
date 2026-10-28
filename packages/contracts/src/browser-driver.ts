// The browser driver ports: what the engine needs from one browser session, split into small
// interfaces. Each driver package implements them; the engine never imports a driver.
// See docs/specs/SPEC-06-cdp-driver.md and docs/specs/SPEC-27-shared-types-and-events.md.
import type { ActionStep, Locator } from './plan.ts';
import type { GuardVerdict } from './policy.ts';
import type { Secret } from './secret.ts';
import type { Result } from './result.ts';
import type { Target } from './target.ts';

// policy-denied: the policy gate's runtime guard refused the action, so no input event was sent.
export type DriverErrorCode = 'not-found' | 'ambiguous' | 'not-actionable' | 'timeout' | 'navigation-failed' | 'policy-denied';
export type DriverError = { readonly code: DriverErrorCode; readonly detail: string };

// Why a declared target cannot run. A driver explains a "no"; it never substitutes another target.
export type UnavailableReason =
  | 'not-declared' | 'adapter-not-registered' | 'engine-not-supported' | 'device-not-supported' | 'launch-failed';
export type Unavailable = { readonly reason: UnavailableReason; readonly detail: string };

// A rectangle in CSS pixels.
export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

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
};
export type PageProbe = { readonly url: string; readonly title: string };

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
// the driver performs nothing and returns policy-denied.
export type ActionGuard = (element: ResolvedElement) => GuardVerdict;

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
  navigate(url: string): Promise<Result<void, DriverError>>;
  page(): Promise<PageProbe>;
}
export interface ActionRunner {
  // Given a guard, the driver asks it first and acts only on an allow. The CDP driver starts
  // passing the resolved element with SPEC-06 (docs/specs/SPEC-06-cdp-driver.md).
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

// One open browser session: every driver port together.
export interface Session extends PageNavigator, ActionRunner, Prober, Camera, Auditor {
  readonly browser: { readonly name: string; readonly version: string };
  // Origins of the requests the session refused, as evidence that the run stayed hermetic.
  blockedOrigins(): readonly string[];
  // Ends the session; every process it started exits.
  close(): Promise<void>;
}

export type AdapterInfo = { readonly id: string; readonly version: string; readonly protocol: string };

export interface BrowserDriver {
  readonly info: AdapterInfo;
  // A pure capability check. It says yes or explains no; it never substitutes.
  supports(target: Target): Result<true, Unavailable>;
  open(target: Target, environment: SessionEnvironment): Promise<Result<Session, Unavailable>>;
}
