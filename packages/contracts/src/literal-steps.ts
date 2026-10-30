// The one place that tells literal text from a value reference, and a step a driver can perform
// from one it cannot. The engine replaces every value reference before a step reaches a driver;
// drivers call literalActionStep and performableLocator once, with the features they declare, and
// refuse on undefined, so no step is ever performed in part.
// Some features of plan language 1.2 are optional for a driver: positions, test-id attributes
// other than data-testid, key chords, multi-line fills, remembered values, accessibility states,
// link targets, head metadata, pages loaded with scripts off, downloads and second tabs. A driver
// declares the ones it performs in its AdapterInfo; the run refuses a step needing one its driver
// does not declare with unsupported-step, before anything of it reaches the driver.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md and
// docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import { DOM_CHECK_KINDS } from './plan.ts';
import type {
  ActionStep, ElementAssertion, Locator, PageAssertion, ResolvedActionStep, ResolvedLocator, SafeText, Step, TextOrValue, ValueName,
} from './plan.ts';

// The test-id attribute a testId locator without `attribute` matches, and the project's default list.
export const DEFAULT_TEST_ID_ATTRIBUTE = 'data-testid';

// Features a driver may perform or not, declared in its AdapterInfo:
//   positions         picks the first, last or nth of a locator's matches, in document order;
//   testIdAttributes  matches a test id on a declared attribute other than data-testid;
//   keyChords         holds modifier keys down while a key is pressed;
//   multiLineFills    inserts lines of text joined by line feeds, with no Enter key press;
//   rememberedValues  lets a remember step read an element's text or input value through its probe;
//   pageStates        reports an element's accessibility states (selected, expanded, pressed,
//                     current) in its probe;
//   linkTargets       reports the resolved href of the link an element is in, in its probe;
//   pageMetadata      reports the head's meta tags and canonical link in its page probe;
//   scriptsDisabled   loads a page with script execution off, until the next navigate;
//   downloads         performs a download step through its download port;
//   newTabs           opens a second tab of the session's browser context.
export const DRIVER_FEATURES = [
  'positions', 'testIdAttributes', 'keyChords', 'multiLineFills', 'rememberedValues',
  'pageStates', 'linkTargets', 'pageMetadata', 'scriptsDisabled', 'downloads', 'newTabs',
] as const;
export type DriverFeature = (typeof DRIVER_FEATURES)[number];

const NO_FEATURES: readonly DriverFeature[] = [];

// The text itself when it is literal; undefined when it is a reference to a run value.
export const literalText = (text: TextOrValue): SafeText | undefined => (typeof text === 'string' ? text : undefined);
// The name of the run value it refers to; undefined when it is literal text.
export const referencedValueName = (text: TextOrValue): ValueName | undefined => (typeof text === 'string' ? undefined : text.valueName);

// The locator with its texts typed as literal text, or undefined when a value reference is left or
// when it is a CSS or XPath locator, which no driver resolves yet.
export function literalLocator(locator: Locator): ResolvedLocator | undefined {
  switch (locator.by) {
    case 'role': { const name = literalText(locator.name); return name === undefined ? undefined : { ...locator, name }; }
    case 'label': { const label = literalText(locator.label); return label === undefined ? undefined : { ...locator, label }; }
    case 'text': { const text = literalText(locator.text); return text === undefined ? undefined : { ...locator, text }; }
    case 'testId': { const testId = literalText(locator.testId); return testId === undefined ? undefined : { ...locator, testId }; }
    case 'css': case 'xpath': return undefined;
  }
}

// The optional driver features a locator uses.
function locatorFeatures(locator: Locator): DriverFeature[] {
  const features: DriverFeature[] = [];
  if (locator.position !== undefined) features.push('positions');
  if (locator.by === 'testId' && locator.attribute !== undefined && locator.attribute !== DEFAULT_TEST_ID_ATTRIBUTE) features.push('testIdAttributes');
  return features;
}

// True when the driver cannot resolve the locator: it finds its element by CSS or XPath, which no
// driver resolves yet, or it uses an optional feature that `performs` does not list.
export const needsLocatorFeatures = (locator: Locator, performs: readonly DriverFeature[] = NO_FEATURES): boolean =>
  locator.by === 'css' || locator.by === 'xpath' || locatorFeatures(locator).some((feature) => !performs.includes(feature));

// Element checks no driver's probe decides yet: it reports no checked or focused state and no
// class, computed style or attribute, so these checks could never pass on their merits.
const ELEMENT_CHECKS_NO_DRIVER_DECIDES: readonly ElementAssertion['kind'][] = ['checked', 'unchecked', 'focused', ...DOM_CHECK_KINDS];
// Element checks of the accessibility states a driver reports when it declares pageStates.
const ACCESSIBLE_STATE_CHECKS: readonly ElementAssertion['kind'][] = ['selected', 'unselected', 'expanded', 'collapsed', 'pressed', 'unpressed', 'current'];
// Page checks of the document head, which a driver reports when it declares pageMetadata.
const PAGE_METADATA_CHECKS: readonly PageAssertion['kind'][] = ['metaContent', 'canonicalUrl'];

const isMultiLine = (value: Extract<Step, { type: 'fill' }>['value']): boolean => typeof value === 'object' && 'lines' in value;

// True when the step needs what its driver does not perform: an optional feature above that
// `performs` does not list (an accessibility state, a link target, the document head, a page
// loaded with scripts off, a download or a check of one, a second tab among them), a CSS or
// XPath locator, a check no probe decides, the driver's network
// and storage ports (stubs, request checks, response checks and reads, and web storage), or its
// clock and clipboard ports (clock advances, clipboard checks and reads). The run reports such a
// step as unsupported-step before anything of it reaches the driver. Hover, select and upload go
// to the driver, which refuses them with unsupported-step when it does not perform them; a frame
// step goes to the driver's frame port. A dialog step goes to the driver, so the runtime guard
// sees the dialog's text before anything answers it.
export function needsDriverFeatures(step: Step, performs: readonly DriverFeature[] = NO_FEATURES): boolean {
  const lacks = (feature: DriverFeature): boolean => !performs.includes(feature);
  switch (step.type) {
    case 'click': case 'hover': case 'select': case 'upload': case 'frame': return needsLocatorFeatures(step.locator, performs);
    case 'press': return needsLocatorFeatures(step.locator, performs) || (step.modifiers !== undefined && lacks('keyChords'));
    case 'fill': return needsLocatorFeatures(step.locator, performs) || (isMultiLine(step.value) && lacks('multiLineFills'));
    case 'expect':
      return needsLocatorFeatures(step.locator, performs) || ELEMENT_CHECKS_NO_DRIVER_DECIDES.includes(step.assert.kind)
        || (ACCESSIBLE_STATE_CHECKS.includes(step.assert.kind) && lacks('pageStates'))
        || (step.assert.kind === 'hrefEquals' && lacks('linkTargets'));
    case 'expectPage': return PAGE_METADATA_CHECKS.includes(step.assert.kind) && lacks('pageMetadata');
    case 'navigate': return step.scripts !== undefined && lacks('scriptsDisabled');
    case 'download': return lacks('downloads') || needsLocatorFeatures(step.locator, performs);
    case 'expectDownload': return lacks('downloads');
    // The tab's own steps are checked one by one as they run, as a frame's are.
    case 'newTab': return lacks('newTabs');
    // The CDP driver's network and storage ports carry these out (docs/specs/SPEC-06-cdp-driver.md).
    case 'stub': case 'resetRequests': case 'expectRequests': case 'expectResponse':
    case 'setStorage': case 'removeStorage': case 'expectStorage': return true;
    // The CDP driver's clock and clipboard ports carry these out, with the determinism kit's timer
    // tracking (docs/specs/SPEC-34-clock-advance-and-clipboard.md).
    case 'advanceClock': case 'expectClipboard': return true;
    // Reading an element's text or value needs only the prober, of a driver that declares it reads
    // values for later steps. Reading a response field needs the network port, reading the
    // clipboard the clipboard port and reading an attribute the DOM reads.
    case 'remember':
      if (!('element' in step.from) || step.from.read === 'attribute') return true;
      return lacks('rememberedValues') || needsLocatorFeatures(step.from.element, performs);
    case 'dialog': case 'a11yAudit': case 'capture': return false;
    // Page scripts need the driver's script port (docs/specs/SPEC-36-unsafe-plan-features.md).
    case 'evaluate': case 'expectScript': return true;
    // Calls never reach a driver: the engine sends them through the run's service caller. Database
    // commands neither: they run in a workload container.
    case 'call': case 'expectBackend': case 'database': case 'expectDatabase': return false;
  }
}

// The locator a driver can match: literal, with no feature the driver lacks.
export const performableLocator = (locator: Locator, performs: readonly DriverFeature[] = NO_FEATURES): ResolvedLocator | undefined =>
  (needsLocatorFeatures(locator, performs) ? undefined : literalLocator(locator));

// The action as a driver that performs `performs` carries it out: literal locator and text, a fill
// of literal text, of literal lines or of a secret reference, and no feature it lacks. Undefined
// means the driver must refuse the step.
export function literalActionStep(step: ActionStep, performs: readonly DriverFeature[] = NO_FEATURES): ResolvedActionStep | undefined {
  // A dialog acts on no element: a driver that answers dialogs does so before calling this.
  if (step.type === 'dialog' || needsDriverFeatures(step, performs)) return undefined;
  const locator = literalLocator(step.locator);
  if (locator === undefined) return undefined;
  switch (step.type) {
    case 'click': case 'hover': return { type: step.type, locator };
    case 'upload': return { type: step.type, locator, fixture: step.fixture };
    case 'press':
      return step.modifiers === undefined ? { type: step.type, locator, key: step.key } : { type: step.type, locator, key: step.key, modifiers: step.modifiers };
    case 'select': {
      const option = literalText(step.option);
      return option === undefined ? undefined : { type: step.type, locator, option };
    }
    case 'fill': {
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
    case 'download': return undefined;
  }
}
