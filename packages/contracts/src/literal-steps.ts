// The one place that tells literal text from a value reference. The engine replaces every value
// reference before a step reaches a driver; drivers call literalActionStep and performableLocator
// once and refuse on undefined, so no step is ever performed in part.
import { ElementStateKind, SemanticLocatorKind, StepType, StructuralLocatorKind, type ElementAssertionKind } from './plan.ts';
import type {
  ActionStep, Locator, ResolvedActionStep, ResolvedLocator, SafeText, SemanticLocatorWith, Step, TextOrValue,
  ValueName,
} from './plan.ts';

// The test-id attribute a testId locator without `attribute` matches, and the project's default list.
export const DEFAULT_TEST_ID_ATTRIBUTE = 'data-testid';

// The text itself when it is literal; undefined when it is a reference to a run value.
export const literalText = (text: TextOrValue): SafeText | undefined => (typeof text === 'string' ? text : undefined);
// The name of the run value it refers to; undefined when it is literal text.
export const referencedValueName = (text: TextOrValue): ValueName | undefined => (typeof text === 'string' ? undefined : text.valueName);

// A role, label, text or test-id locator with its texts typed as literal text, or undefined when a
// value reference is left or when it is a css or XPath locator (performableLocator takes those).
export function literalLocator(locator: Locator): SemanticLocatorWith<SafeText> | undefined {
  switch (locator.by) {
    case SemanticLocatorKind.Role: { const name = literalText(locator.name); return name === undefined ? undefined : { ...locator, name }; }
    case SemanticLocatorKind.Label: { const label = literalText(locator.label); return label === undefined ? undefined : { ...locator, label }; }
    case SemanticLocatorKind.Text: { const text = literalText(locator.text); return text === undefined ? undefined : { ...locator, text }; }
    case SemanticLocatorKind.TestId: { const testId = literalText(locator.testId); return testId === undefined ? undefined : { ...locator, testId }; }
    case StructuralLocatorKind.Css: case StructuralLocatorKind.Xpath: return undefined;
  }
}

// Any locator with its texts typed as literal text, the locators it is inside included, or
// undefined when a value reference is left anywhere in it.
function literalLocatorOfAnyKind(locator: Locator): ResolvedLocator | undefined {
  if (locator.by !== StructuralLocatorKind.Css && locator.by !== StructuralLocatorKind.Xpath) return literalLocator(locator);
  const hasText = locator.hasText === undefined ? undefined : literalText(locator.hasText);
  if (locator.hasText !== undefined && hasText === undefined) return undefined;
  const inside = locator.inside === undefined ? undefined : literalLocatorOfAnyKind(locator.inside);
  if (locator.inside !== undefined && inside === undefined) return undefined;
  const optional = {
    ...(hasText === undefined ? {} : { hasText }), ...(inside === undefined ? {} : { inside }),
    ...(locator.position === undefined ? {} : { position: locator.position }),
  };
  return locator.by === StructuralLocatorKind.Css
    ? { by: StructuralLocatorKind.Css, selector: locator.selector, ...optional }
    : { by: StructuralLocatorKind.Xpath, expression: locator.expression, ...optional };
}

// Element checks no driver's probe decides yet: it reports no checked or focused state, so these
// checks could never pass on their merits.
const ELEMENT_CHECKS_NO_DRIVER_DECIDES: readonly ElementAssertionKind[] = [ElementStateKind.Checked, ElementStateKind.Unchecked, ElementStateKind.Focused];
// True for a check that can only ever fail, whichever driver runs it. A run refuses a plan holding one.
export const isElementCheckNoDriverDecides = (step: Step): boolean => step.type === StepType.Expect && ELEMENT_CHECKS_NO_DRIVER_DECIDES.includes(step.assert.kind);
// The locator a driver can match, with its texts and those of the locators it is inside typed as
// literal text. Undefined means a value reference is left, and the driver must refuse the step.
export const performableLocator = literalLocatorOfAnyKind;

// The action as a driver carries it out: literal locator and text, and a fill of literal text, of
// literal lines or of a secret reference. Undefined means the driver must refuse the step.
export function literalActionStep(step: ActionStep): ResolvedActionStep | undefined {
  // A dialog acts on no element: a driver that answers dialogs does so before calling this.
  if (step.type === StepType.Dialog) return undefined;
  const locator = literalLocatorOfAnyKind(step.locator);
  if (locator === undefined) return undefined;
  switch (step.type) {
    case StepType.Click: case StepType.Hover: return { type: step.type, locator };
    case StepType.Upload: return { type: step.type, locator, fixture: step.fixture };
    case StepType.Press:
      return step.modifiers === undefined ? { type: step.type, locator, key: step.key } : { type: step.type, locator, key: step.key, modifiers: step.modifiers };
    case StepType.Select: {
      const option = literalText(step.option);
      return option === undefined ? undefined : { type: step.type, locator, option };
    }
    case StepType.Fill: {
      if (typeof step.value === 'object' && 'secretName' in step.value) return { type: step.type, locator, value: step.value };
      if (typeof step.value === 'object' && 'lines' in step.value) {
        const lines: SafeText[] = [];
        for (const line of step.value.lines) {
          const literal = literalText(line);
          if (literal === undefined) return undefined;
          lines.push(literal);
        }
        return { type: step.type, locator, value: { lines } };
      }
      const value = literalText(step.value);
      return value === undefined ? undefined : { type: step.type, locator, value };
    }
    // A download goes through the driver's download port, never through act.
    case StepType.Download: return undefined;
  }
}
