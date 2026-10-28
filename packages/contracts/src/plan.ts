// The plan language: a closed, versioned union of steps. An AI or a person may propose a plan,
// but only the engine's plan parser can produce the branded Plan that the interpreter accepts.
// The types live here because drivers act on steps and locators; the parser lives in the engine.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import type { Brand } from './brand.ts';
import type { TargetId } from './target.ts';

export const PLAN_VERSION = 1;

// Text that passed the engine's safety rules: no control or bidirectional-override characters
// and nothing that looks like script.
export type SafeText = Brand<string, 'SafeText'>;

export const ROLES = [
  'alert', 'button', 'checkbox', 'combobox', 'dialog', 'heading', 'img', 'link', 'listitem',
  'main', 'navigation', 'option', 'radio', 'region', 'searchbox', 'status', 'switch', 'tab', 'textbox',
] as const;
export type Role = (typeof ROLES)[number];

export const KEYS = ['Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
export type Key = (typeof KEYS)[number];

// Role-first and name-first locators. There is no CSS or XPath: both are brittle and can encode logic.
export type Locator =
  | { readonly by: 'role'; readonly role: Role; readonly name: SafeText }
  | { readonly by: 'label'; readonly label: SafeText }
  | { readonly by: 'text'; readonly text: SafeText }
  | { readonly by: 'testId'; readonly testId: SafeText };

// A closed set of assertions. What "passed" means is decided by the engine's oracle, never by a
// driver or an AI.
export type ElementAssertion =
  | { readonly kind: 'visible' }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'enabled' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'textEquals'; readonly value: SafeText }
  | { readonly kind: 'textContains'; readonly value: SafeText }
  | { readonly kind: 'valueEquals'; readonly value: SafeText }
  | { readonly kind: 'valueContains'; readonly value: SafeText };
export type PageAssertion =
  | { readonly kind: 'urlPath'; readonly value: SafeText }
  | { readonly kind: 'title'; readonly value: SafeText };

// A URL path, or an absolute URL whose origin is on the project's allow-list.
export type AllowedUrl = Brand<string, 'AllowedUrl'>;
export type CaptureName = Brand<string, 'CaptureName'>;
export type FeatureId = Brand<string, 'FeatureId'>;

export type Step =
  | { readonly type: 'navigate'; readonly url: AllowedUrl }
  | { readonly type: 'click'; readonly locator: Locator }
  | { readonly type: 'fill'; readonly locator: Locator; readonly value: SafeText }
  | { readonly type: 'press'; readonly locator: Locator; readonly key: Key }
  | { readonly type: 'expect'; readonly locator: Locator; readonly assert: ElementAssertion }
  | { readonly type: 'expectPage'; readonly assert: PageAssertion }
  | { readonly type: 'a11yAudit'; readonly mode: 'report' | 'gate' }
  | { readonly type: 'capture'; readonly name: CaptureName };
export type StepType = Step['type'];
// The steps a driver performs on an element.
export type ActionStep = Extract<Step, { type: 'click' | 'fill' | 'press' }>;

export type PlanMeta = { readonly featureId: FeatureId; readonly specReference: SafeText; readonly title: SafeText };

export type PlanData = {
  readonly version: typeof PLAN_VERSION;
  readonly meta: PlanMeta;
  readonly targets: readonly TargetId[];
  readonly steps: readonly Step[];
};
export type Plan = Brand<PlanData, 'Plan'>;
