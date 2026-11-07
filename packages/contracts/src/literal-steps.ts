// The one place that tells literal text from a value reference. The engine replaces every value
// reference before a step reaches a driver, whose ports take only resolved types.
import { ElementStateKind, SemanticLocatorKind, StructuralLocatorKind, type ElementAssertionKind } from './plan.ts';
import type { Locator, SemanticLocatorWith, Step } from './plan.ts';
import { StepType } from './StepType.ts';
import type { SafeText, TextOrValue, ValueName } from './TextOrValue.ts';

// The test-id attribute a testId locator without `attribute` matches, and the project's default list.
export const DEFAULT_TEST_ID_ATTRIBUTE = 'data-testid';

// The text itself when it is literal; undefined when it is a reference to a run value.
export const literalText = (text: TextOrValue): SafeText | undefined => (typeof text === 'string' ? text : undefined);
// The name of the run value it refers to; undefined when it is literal text.
export const referencedValueName = (text: TextOrValue): ValueName | undefined => (typeof text === 'string' ? undefined : text.valueName);

// A role, label, text or test-id locator with its texts typed as literal text, or undefined when a
// value reference is left or when it is a css or XPath locator.
export function literalLocator(locator: Locator): SemanticLocatorWith<SafeText> | undefined {
  switch (locator.by) {
    case SemanticLocatorKind.Role: { const name = literalText(locator.name); return name === undefined ? undefined : { ...locator, name }; }
    case SemanticLocatorKind.Label: { const label = literalText(locator.label); return label === undefined ? undefined : { ...locator, label }; }
    case SemanticLocatorKind.Text: { const text = literalText(locator.text); return text === undefined ? undefined : { ...locator, text }; }
    case SemanticLocatorKind.TestId: { const testId = literalText(locator.testId); return testId === undefined ? undefined : { ...locator, testId }; }
    case StructuralLocatorKind.Css: case StructuralLocatorKind.Xpath: return undefined;
  }
}

// Element checks no driver's probe decides yet: it reports no checked or focused state, so these
// checks could never pass on their merits.
const ELEMENT_CHECKS_NO_DRIVER_DECIDES: readonly ElementAssertionKind[] = [ElementStateKind.Checked, ElementStateKind.Unchecked, ElementStateKind.Focused];
// True for a check that can only ever fail, whichever driver runs it. A run refuses a plan holding one.
export const isElementCheckNoDriverDecides = (step: Step): boolean => step.type === StepType.Expect && ELEMENT_CHECKS_NO_DRIVER_DECIDES.includes(step.assert.kind);
