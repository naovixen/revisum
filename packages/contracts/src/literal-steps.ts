// The one place that tells literal text from a value reference, and a step a driver can perform
// today from one it cannot. The engine replaces every value reference before a step reaches a
// driver; drivers call literalActionStep and performableLocator once and refuse on undefined, so
// no step is ever performed in part. Positions, test-id attributes other than data-testid, key
// chords, multi-line text, the accessibility states, link targets, head metadata, pages loaded
// with scripts off, downloads and second tabs come with the CDP driver
// (docs/specs/SPEC-06-cdp-driver.md).
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md and
// docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import type {
  ActionStep, ElementAssertion, Locator, PageAssertion, ResolvedActionStep, ResolvedLocator, SafeText, Step, TextOrValue, ValueName,
} from './plan.ts';

// The test-id attribute a testId locator without `attribute` matches, and the project's default list.
export const DEFAULT_TEST_ID_ATTRIBUTE = 'data-testid';

// The text itself when it is literal; undefined when it is a reference to a run value.
export const literalText = (text: TextOrValue): SafeText | undefined => (typeof text === 'string' ? text : undefined);
// The name of the run value it refers to; undefined when it is literal text.
export const referencedValueName = (text: TextOrValue): ValueName | undefined => (typeof text === 'string' ? undefined : text.valueName);

// The locator with its texts typed as literal text, or undefined when a value reference is left.
export function literalLocator(locator: Locator): ResolvedLocator | undefined {
  switch (locator.by) {
    case 'role': { const name = literalText(locator.name); return name === undefined ? undefined : { ...locator, name }; }
    case 'label': { const label = literalText(locator.label); return label === undefined ? undefined : { ...locator, label }; }
    case 'text': { const text = literalText(locator.text); return text === undefined ? undefined : { ...locator, text }; }
    case 'testId': { const testId = literalText(locator.testId); return testId === undefined ? undefined : { ...locator, testId }; }
  }
}

// True when the locator picks a position among its matches, or matches a test id on an attribute
// other than the default: what the drivers do not resolve yet.
export const needsLocatorFeatures = (locator: Locator): boolean =>
  locator.position !== undefined
  || (locator.by === 'testId' && locator.attribute !== undefined && locator.attribute !== DEFAULT_TEST_ID_ATTRIBUTE);

// Element checks the drivers' probe cannot decide yet: it reports no checked, focused or
// accessibility state and no link target, so these checks could never pass on their merits.
const ELEMENT_CHECKS_NO_DRIVER_DECIDES: readonly ElementAssertion['kind'][] = [
  'checked', 'unchecked', 'focused', 'selected', 'unselected', 'expanded', 'collapsed', 'pressed', 'unpressed', 'current', 'hrefEquals',
];
// Page checks the drivers' page probe cannot decide yet: it reads no part of the document head.
const PAGE_CHECKS_NO_DRIVER_DECIDES: readonly PageAssertion['kind'][] = ['metaContent', 'canonicalUrl'];

// True when the step needs what no driver performs yet: a locator feature above, a key chord,
// multi-line text, a check the probes cannot decide, a page loaded with scripts off, a download,
// a check of a download, a second tab, or the driver's network and storage ports: stubs, request
// checks, response checks and reads, and web storage. The run reports such a step as
// unsupported-step before anything of it reaches the driver. Steps no driver performs at all
// (hover, select, upload, frame, dialog and remember) are the run's to refuse whole.
export function needsDriverFeatures(step: Step): boolean {
  switch (step.type) {
    case 'click': case 'hover': case 'select': case 'upload': return needsLocatorFeatures(step.locator);
    case 'press': return needsLocatorFeatures(step.locator) || step.modifiers !== undefined;
    case 'fill': return needsLocatorFeatures(step.locator) || (typeof step.value === 'object' && 'lines' in step.value);
    case 'expect': return needsLocatorFeatures(step.locator) || ELEMENT_CHECKS_NO_DRIVER_DECIDES.includes(step.assert.kind);
    case 'expectPage': return PAGE_CHECKS_NO_DRIVER_DECIDES.includes(step.assert.kind);
    case 'navigate': return step.scripts !== undefined;
    case 'download': case 'expectDownload': case 'newTab': return true;
    // The CDP driver's network and storage ports carry these out (docs/specs/SPEC-06-cdp-driver.md).
    case 'stub': case 'resetRequests': case 'expectRequests': case 'expectResponse':
    case 'setStorage': case 'removeStorage': case 'expectStorage': return true;
    // Reading a response field needs the network port; reading an element only the prober.
    case 'remember': return 'response' in step.from;
    case 'frame': case 'dialog': case 'a11yAudit': case 'capture': return false;
    // Calls never reach a driver: the engine sends them through the run's service caller.
    case 'call': case 'expectBackend': return false;
  }
}

// The locator a driver can match today: literal, with no locator feature it lacks.
export const performableLocator = (locator: Locator): ResolvedLocator | undefined =>
  (needsLocatorFeatures(locator) ? undefined : literalLocator(locator));

// The action as a driver performs it today: literal locator and text, a fill of literal text or of
// a secret reference, and no feature it lacks. Undefined means the driver must refuse the step.
export function literalActionStep(step: ActionStep): ResolvedActionStep | undefined {
  if (needsDriverFeatures(step)) return undefined;
  const locator = literalLocator(step.locator);
  if (locator === undefined) return undefined;
  switch (step.type) {
    case 'click': case 'hover': return { type: step.type, locator };
    case 'upload': return { type: step.type, locator, fixture: step.fixture };
    case 'press': return { type: step.type, locator, key: step.key };
    case 'select': {
      const option = literalText(step.option);
      return option === undefined ? undefined : { type: step.type, locator, option };
    }
    case 'fill': {
      // Lines were refused above, so the value is text, a value reference or a secret reference.
      if (typeof step.value === 'object' && 'secretName' in step.value) return { type: step.type, locator, value: step.value };
      const value = typeof step.value === 'object' && 'lines' in step.value ? undefined : literalText(step.value);
      return value === undefined ? undefined : { type: step.type, locator, value };
    }
    // Refused above: no driver performs a download yet.
    case 'download': return undefined;
  }
}
