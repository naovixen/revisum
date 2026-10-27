// The browser driver ports: what the engine needs from one browser session, split into small
// interfaces. Each driver package implements them; the engine never imports a driver.
// See docs/specs/SPEC-06-cdp-driver.md and docs/specs/SPEC-27-shared-types-and-events.md.
import type { ActionStep, Locator } from './plan.ts';
import type { Result } from './result.ts';
import type { Target } from './target.ts';

export type DriverErrorCode = 'not-found' | 'ambiguous' | 'not-actionable' | 'timeout' | 'navigation-failed';
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
  act(step: ActionStep): Promise<Result<void, DriverError>>;
}
export interface Prober {
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
