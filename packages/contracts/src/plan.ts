// The plan language: a closed, versioned union of steps. An AI or a person may propose a plan,
// but only the engine's plan parser can produce the branded Plan that the interpreter accepts.
// The types live here because drivers act on steps and locators; the parser lives in the engine.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import type { Brand } from './brand.ts';
import type { TargetId } from './target.ts';

// The language version the running engine parses. A plan declares it as the text "1.1"; plans of
// version 1 reach the engine only through its migration, which adds what version 1 lacked.
export const PLAN_VERSION = { major: 1, minor: 1 } as const;

// Text that passed the engine's safety rules: no control or bidirectional-override characters
// and nothing that looks like script.
export type SafeText = Brand<string, 'SafeText'>;

export const ROLES = [
  'alert', 'button', 'checkbox', 'combobox', 'dialog', 'heading', 'img', 'link', 'listitem',
  'main', 'navigation', 'option', 'radio', 'region', 'searchbox', 'status', 'switch', 'tab', 'textbox',
  'listbox', 'menuitem', 'table', 'row', 'cell', 'form',
] as const;
export type Role = (typeof ROLES)[number];

export const KEYS = [
  'Enter', 'Space', 'Tab', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
] as const;
export type Key = (typeof KEYS)[number];

// Role-first and name-first locators. There is no CSS or XPath: both are brittle and can encode logic.
export type Locator =
  | { readonly by: 'role'; readonly role: Role; readonly name: SafeText }
  | { readonly by: 'label'; readonly label: SafeText }
  | { readonly by: 'text'; readonly text: SafeText }
  | { readonly by: 'testId'; readonly testId: SafeText };
export const LOCATOR_KINDS = ['role', 'label', 'text', 'testId'] as const;

// A closed set of assertions. What "passed" means is decided by the engine's oracle, never by a
// driver or an AI. The kind names the check; `value` is what it compares against.
// State checks compare against nothing. `absent` means no element matches at all, unlike
// `hidden`, which also passes for one element that is present but not shown.
export const ELEMENT_STATE_KINDS = ['visible', 'hidden', 'enabled', 'disabled', 'absent', 'checked', 'unchecked', 'focused'] as const;
// Text checks compare against non-empty text: an empty expected text would match anything.
export const ELEMENT_TEXT_KINDS = ['textEquals', 'textContains', 'valueEquals', 'valueContains'] as const;
export type ElementAssertion =
  | { readonly kind: (typeof ELEMENT_STATE_KINDS)[number] }
  | { readonly kind: (typeof ELEMENT_TEXT_KINDS)[number]; readonly value: SafeText }
  | { readonly kind: 'countEquals'; readonly value: number };

export const PAGE_TEXT_KINDS = ['urlPath', 'title'] as const;
export type PageAssertion =
  | { readonly kind: (typeof PAGE_TEXT_KINDS)[number]; readonly value: SafeText }
  // The whole URL, compared after resolving it against the page's own URL.
  | { readonly kind: 'url'; readonly value: AllowedUrl };

// A URL path, or an absolute URL whose origin is on the project's allow-list.
export type AllowedUrl = Brand<string, 'AllowedUrl'>;
export type CaptureName = Brand<string, 'CaptureName'>;
export type FeatureId = Brand<string, 'FeatureId'>;
// The id of the acceptance criterion an assertion checks, from the user's own spec, such as "AC-3".
export type CriterionId = Brand<string, 'CriterionId'>;
// A file the trusted project declares in its fixtures list, which an upload step may send.
export type FixtureName = Brand<string, 'FixtureName'>;
// The name of a secret the trusted project declares. A plan names a secret; it never holds one.
export type SecretName = Brand<string, 'SecretName'>;
export type SecretReference = { readonly secretName: SecretName };

export type Step =
  | { readonly type: 'navigate'; readonly url: AllowedUrl }
  | { readonly type: 'click'; readonly locator: Locator }
  | { readonly type: 'hover'; readonly locator: Locator }
  | { readonly type: 'fill'; readonly locator: Locator; readonly value: SafeText | SecretReference }
  | { readonly type: 'select'; readonly locator: Locator; readonly option: SafeText }
  | { readonly type: 'upload'; readonly locator: Locator; readonly fixture: FixtureName }
  | { readonly type: 'press'; readonly locator: Locator; readonly key: Key }
  // Runs its steps inside the iframe the locator finds.
  | { readonly type: 'frame'; readonly locator: Locator; readonly steps: readonly Step[] }
  // Answers the next dialog the page opens, optionally checking its text first.
  | { readonly type: 'dialog'; readonly action: 'accept' | 'dismiss'; readonly expectText?: SafeText }
  | { readonly type: 'expect'; readonly locator: Locator; readonly assert: ElementAssertion; readonly criterionId: CriterionId }
  | { readonly type: 'expectPage'; readonly assert: PageAssertion; readonly criterionId: CriterionId }
  | { readonly type: 'a11yAudit'; readonly mode: 'report' | 'gate' }
  | { readonly type: 'capture'; readonly name: CaptureName };
export type StepType = Step['type'];
// The steps that act on an element; the driver's ActionRunner port performs them.
export type ActionStep = Extract<Step, { type: 'click' | 'hover' | 'fill' | 'select' | 'upload' | 'press' }>;
export const DIALOG_ACTIONS = ['accept', 'dismiss'] as const;
export const AUDIT_MODES = ['report', 'gate'] as const;

export type PlanMeta = { readonly featureId: FeatureId; readonly specReference: SafeText; readonly title: SafeText };

export type PlanData = {
  readonly version: `${number}.${number}`;
  readonly meta: PlanMeta;
  readonly targets: readonly TargetId[];
  readonly steps: readonly Step[];
  // Saved browser storage state (cookies and local storage) to start the session with. It is a
  // secret a person exported, so the plan names it and the secret store holds the JSON.
  readonly storageState?: SecretReference;
};
export type Plan = Brand<PlanData, 'Plan'>;
