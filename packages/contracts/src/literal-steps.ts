// The one place that tells literal text from a value reference, and a step a driver can perform
// today from one it cannot. The engine replaces every value reference before a step reaches a
// driver; drivers call literalActionStep and performableLocator once and refuse on undefined, so
// no step is ever performed in part. Positions, test-id attributes other than data-testid, key
// chords and multi-line text come with the CDP driver (docs/specs/SPEC-06-cdp-driver.md).
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import type { ActionStep, Locator, ResolvedActionStep, ResolvedLocator, SafeText, TextOrValue, ValueName } from './plan.ts';

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

// True when the action needs what no driver performs yet: a locator feature above, a key chord or
// multi-line text. The run reports such a step as unsupported-step before it acts.
export function needsDriverFeatures(step: ActionStep): boolean {
  if (needsLocatorFeatures(step.locator)) return true;
  if (step.type === 'press') return step.modifiers !== undefined;
  return step.type === 'fill' && typeof step.value === 'object' && 'lines' in step.value;
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
  }
}
