// The seam each browser protocol implements once. buildSession (browser-session.ts) turns a
// PageOperations into a Session, so auto-waiting, probes and audits behave the same on every
// protocol.
import type { A11yNode, BrowserDriver, Key, Result, Session, SessionEnvironment, Target, Unavailable } from '@revisum/contracts';
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
  navigate(url: string, timeoutMilliseconds: number): Promise<void>;
  // Calls a page function that returns a string (JSON where structured). Promises are awaited.
  callForString(pageFunction: PageFunction, inputs: readonly PageArgument<Handle>[]): Promise<string>;
  // Calls a page function that returns Element[], and returns their handles.
  callForElements(pageFunction: PageFunction, inputs: readonly PageArgument<Handle>[]): Promise<Handle[]>;
  // Elements with this role and exact accessible name, found by the browser's own accessibility engine.
  byRole(role: string, name: string): Promise<Handle[]>;
  accessibilityTree(): Promise<A11yNode>;
  click(element: Handle, at: Point): Promise<void>;
  fill(element: Handle, value: string): Promise<void>;
  press(element: Handle, key: Key): Promise<void>;
  // A PNG of the viewport.
  screenshotPng(): Promise<Uint8Array>;
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
}

export interface OwnBrowserDriver extends BrowserDriver {
  open(target: Target, environment: SessionEnvironment): Promise<Result<DriverSession, Unavailable>>;
}
