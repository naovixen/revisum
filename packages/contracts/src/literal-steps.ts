// The one place that tells literal text from a value reference, and a step a driver can perform
// from one it cannot. The engine replaces every value reference before a step reaches a driver;
// drivers call literalActionStep and performableLocator once, with the features they declare, and
// refuse on undefined, so no step is ever performed in part.
// Some features of the plan language are optional for a driver: positions, test-id
// attributes other than data-testid, key chords, multi-line fills, remembered values, accessibility
// states, link targets, head metadata, pages loaded with scripts off, downloads, second tabs,
// network stubs, request checks, web storage, clock advances, the clipboard, css and XPath
// locators, DOM checks and page scripts. A driver declares the ones it performs in its
// AdapterInfo; the run refuses a step needing one its driver does not declare with
// unsupported-step, before anything of it reaches the driver.
import { DOM_CHECK_KINDS, ElementStateKind, REMEMBER_ATTRIBUTE_READ, SemanticLocatorKind, StructuralLocatorKind } from './plan.ts';
import type {
  ActionStep, ElementAssertion, Locator, PageAssertion, ResolvedActionStep, ResolvedLocator, SafeText, SemanticLocatorWith, Step, TextOrValue,
  ValueName,
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
//   linkTargets       reports the resolved href of the link an element is in, in its probe, and
//                     lists the document's link targets, which a crawl follows;
//   pageMetadata      reports the head's meta tags and canonical link in its page probe;
//   scriptsDisabled   loads a page with script execution off, until the next navigate;
//   downloads         performs a download step through its download port;
//   newTabs           opens a second tab of the session's browser context;
//   networkStubs      answers the page's fetch and XHR requests with a declared stub's responses,
//                     through its network port;
//   requestChecks     records the exchanges of the requests a plan names, through its network port,
//                     so a plan may count them and check or remember their latest response;
//   storage           writes, removes and reads local and session storage entries, through its
//                     storage port;
//   clockControl      runs the page's timers on the run's virtual clock and moves that clock forward,
//                     through its clock port;
//   clipboard         reads the plain text of the run's own in-memory clipboard, through its clipboard port;
//   structuralLocators
//                     finds elements by a css selector or an XPath expression, with hasText and
//                     inside, and fails a selector the browser rejects with selector-invalid;
//   domChecks         reads an element's classes, one computed style or one attribute in its probe,
//                     for the DOM checks (a remember from an attribute needs rememberedValues too);
//   pageScripts       runs a declared or inline page script in the page, through its script port.
export const DriverFeature = {
  Positions: 'positions',
  TestIdAttributes: 'testIdAttributes',
  KeyChords: 'keyChords',
  MultiLineFills: 'multiLineFills',
  RememberedValues: 'rememberedValues',
  PageStates: 'pageStates',
  LinkTargets: 'linkTargets',
  PageMetadata: 'pageMetadata',
  ScriptsDisabled: 'scriptsDisabled',
  Downloads: 'downloads',
  NewTabs: 'newTabs',
  NetworkStubs: 'networkStubs',
  RequestChecks: 'requestChecks',
  Storage: 'storage',
  ClockControl: 'clockControl',
  Clipboard: 'clipboard',
  StructuralLocators: 'structuralLocators',
  DomChecks: 'domChecks',
  PageScripts: 'pageScripts',
} as const;
export type DriverFeature = (typeof DriverFeature)[keyof typeof DriverFeature];
export const DRIVER_FEATURES: readonly DriverFeature[] = Object.values(DriverFeature);

const NO_FEATURES: readonly DriverFeature[] = [];

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

// The optional driver features a locator uses, the locators it is inside included.
function locatorFeatures(locator: Locator): DriverFeature[] {
  const features: DriverFeature[] = [];
  if (locator.position !== undefined) features.push(DriverFeature.Positions);
  if (locator.by === SemanticLocatorKind.TestId && locator.attribute !== undefined && locator.attribute !== DEFAULT_TEST_ID_ATTRIBUTE) features.push(DriverFeature.TestIdAttributes);
  if (locator.by === StructuralLocatorKind.Css || locator.by === StructuralLocatorKind.Xpath) {
    features.push(DriverFeature.StructuralLocators);
    if (locator.inside !== undefined) features.push(...locatorFeatures(locator.inside));
  }
  return features;
}

// True when the driver cannot resolve the locator: it uses an optional feature, such as a css or
// XPath selector, that `performs` does not list.
const needsLocatorFeatures = (locator: Locator, performs: readonly DriverFeature[] = NO_FEATURES): boolean =>
  locatorFeatures(locator).some((feature) => !performs.includes(feature));

// Element checks no driver's probe decides yet: it reports no checked or focused state, so these
// checks could never pass on their merits.
const ELEMENT_CHECKS_NO_DRIVER_DECIDES: readonly ElementAssertion['kind'][] = [ElementStateKind.Checked, ElementStateKind.Unchecked, ElementStateKind.Focused];
// True for a check that can only ever fail, whichever driver runs it. A run refuses a plan holding one.
export const isElementCheckNoDriverDecides = (step: Step): boolean => step.type === 'expect' && ELEMENT_CHECKS_NO_DRIVER_DECIDES.includes(step.assert.kind);
// Element checks of classes, computed styles and attributes, which a driver reads when it declares domChecks.
const DOM_CHECKS: readonly ElementAssertion['kind'][] = DOM_CHECK_KINDS;
// Element checks of the accessibility states a driver reports when it declares pageStates.
const ACCESSIBLE_STATE_CHECKS: readonly ElementAssertion['kind'][] = [
  ElementStateKind.Selected, ElementStateKind.Unselected, ElementStateKind.Expanded, ElementStateKind.Collapsed, ElementStateKind.Pressed,
  ElementStateKind.Unpressed, ElementStateKind.Current,
];
// Page checks of the document head, which a driver reports when it declares pageMetadata.
const PAGE_METADATA_CHECKS: readonly PageAssertion['kind'][] = ['metaContent', 'canonicalUrl'];

const isMultiLine = (value: Extract<Step, { type: 'fill' }>['value']): boolean => typeof value === 'object' && 'lines' in value;

// True when the step needs what its driver does not perform: an optional feature above that
// `performs` does not list (an accessibility state, a link target, the document head, a page
// loaded with scripts off, a download or a check of one, a second tab, a stub, a request or
// response check or read, a storage step, a clock advance, a clipboard check or read, a css or
// XPath locator, a DOM check or a page script among them), or a check no probe decides. The run
// reports such a step as unsupported-step before anything of it reaches the driver. Hover, select
// and upload go to the driver, which refuses them with unsupported-step when it does not perform
// them; a frame step goes to the driver's frame port. A dialog step goes to the driver, so the
// runtime guard sees the dialog's text before anything answers it.
export function needsDriverFeatures(step: Step, performs: readonly DriverFeature[] = NO_FEATURES): boolean {
  const lacks = (feature: DriverFeature): boolean => !performs.includes(feature);
  switch (step.type) {
    case 'click': case 'hover': case 'select': case 'upload': case 'frame': return needsLocatorFeatures(step.locator, performs);
    case 'press': return needsLocatorFeatures(step.locator, performs) || (step.modifiers !== undefined && lacks(DriverFeature.KeyChords));
    case 'fill': return needsLocatorFeatures(step.locator, performs) || (isMultiLine(step.value) && lacks(DriverFeature.MultiLineFills));
    case 'expect':
      return needsLocatorFeatures(step.locator, performs) || isElementCheckNoDriverDecides(step)
        || (DOM_CHECKS.includes(step.assert.kind) && lacks(DriverFeature.DomChecks))
        || (ACCESSIBLE_STATE_CHECKS.includes(step.assert.kind) && lacks(DriverFeature.PageStates))
        || (step.assert.kind === 'hrefEquals' && lacks(DriverFeature.LinkTargets));
    case 'expectPage': return PAGE_METADATA_CHECKS.includes(step.assert.kind) && lacks(DriverFeature.PageMetadata);
    case 'navigate': return step.scripts !== undefined && lacks(DriverFeature.ScriptsDisabled);
    case 'download': return lacks(DriverFeature.Downloads) || needsLocatorFeatures(step.locator, performs);
    case 'expectDownload': return lacks(DriverFeature.Downloads);
    // The tab's own steps are checked one by one as they run, as a frame's are.
    case 'newTab': return lacks(DriverFeature.NewTabs);
    // The driver's network and storage ports carry these out.
    case 'stub': return lacks(DriverFeature.NetworkStubs);
    case 'resetRequests': case 'expectRequests': case 'expectResponse': return lacks(DriverFeature.RequestChecks);
    case 'setStorage': case 'removeStorage': case 'expectStorage': return lacks(DriverFeature.Storage);
    // The driver's clock and clipboard ports carry these out.
    case 'advanceClock': return lacks(DriverFeature.ClockControl);
    case 'expectClipboard': return lacks(DriverFeature.Clipboard);
    // Reading an element's text or value needs only the prober, of a driver that declares it reads
    // values for later steps. Reading a response field needs the request checks of the network
    // port; reading the clipboard needs the clipboard port and reading an attribute the DOM reads too.
    case 'remember':
      if ('response' in step.from) return lacks(DriverFeature.RequestChecks);
      if ('clipboard' in step.from) return lacks(DriverFeature.Clipboard);
      return lacks(DriverFeature.RememberedValues) || (step.from.read === REMEMBER_ATTRIBUTE_READ && lacks(DriverFeature.DomChecks)) || needsLocatorFeatures(step.from.element, performs);
    case 'dialog': case 'a11yAudit': case 'capture': return false;
    // Page scripts run through the driver's script port, in the document the step stands in.
    case 'evaluate': case 'expectScript': return lacks(DriverFeature.PageScripts);
    // Calls never reach a driver: the engine sends them through the run's service caller. Database
    // commands neither: they run in a workload container.
    case 'call': case 'expectBackend': case 'database': case 'expectDatabase': return false;
  }
}

// The locator a driver can match: literal, with no feature the driver lacks.
export const performableLocator = (locator: Locator, performs: readonly DriverFeature[] = NO_FEATURES): ResolvedLocator | undefined =>
  (needsLocatorFeatures(locator, performs) ? undefined : literalLocatorOfAnyKind(locator));

// The action as a driver that performs `performs` carries it out: literal locator and text, a fill
// of literal text, of literal lines or of a secret reference, and no feature it lacks. Undefined
// means the driver must refuse the step.
export function literalActionStep(step: ActionStep, performs: readonly DriverFeature[] = NO_FEATURES): ResolvedActionStep | undefined {
  // A dialog acts on no element: a driver that answers dialogs does so before calling this.
  if (step.type === 'dialog' || needsDriverFeatures(step, performs)) return undefined;
  const locator = literalLocatorOfAnyKind(step.locator);
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
