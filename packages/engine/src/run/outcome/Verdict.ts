// The assertion oracle: pure functions from a probe to a verdict. It lives in the engine so that
// neither a driver nor an AI can change what "passed" means.
import {
  PageAssertionKind, PageTextKind, ElementStateKind, DomCheckKind, DomReadKind, ElementAssertionKind, StepCode, literalText, oneElementOf, type AccessibleStates, type DomCheckWith, type DomRead, type ElementProbe, type OneElementRead, type PageAssertion, type PageProbe,
  type ResolvedElementAssertion, type SafeText, UnreadablePage,
} from '@revisum/contracts';

// state-not-exposed: the element does not expose the state a check asks about, so the check can
// neither pass nor fail on its merits.
// selector-invalid: the browser rejects the locator's css selector or XPath expression, so no
// element can ever match and waiting is pointless.
// page-unreadable and dialog-open: the probe could not read the page, so nothing is known of it.
// navigation-failed: the browser shows its own error page, so the page never loaded.
type CheckFailure = 'not-found' | 'ambiguous' | 'assertion-failed' | 'state-not-exposed' | 'selector-invalid' | 'navigation-failed' | UnreadablePage;
// A check that passed, or one that failed and says why.
export type Verdict = { readonly pass: true } | { readonly pass: false; readonly code: CheckFailure };

const PASSED: Verdict = { pass: true };
const FAILED: Verdict = { pass: false, code: StepCode.AssertionFailed };
const STATE_NOT_EXPOSED: Verdict = { pass: false, code: StepCode.StateNotExposed };
const NAVIGATION_FAILED: Verdict = { pass: false, code: UnreadablePage.BrowserErrorPage };

// What a DOM check needs the probe to read of the element; null for every other check.
export function domReadFor(assertion: ResolvedElementAssertion): DomRead | null {
  switch (assertion.kind) {
    case ElementAssertionKind.HasClass: case ElementAssertionKind.LacksClass: return { kind: DomReadKind.Classes };
    case ElementAssertionKind.ComputedStyleEquals: return { kind: DomReadKind.ComputedStyle, property: assertion.property };
    case ElementAssertionKind.AttributeEquals: case ElementAssertionKind.AttributeAbsent: return { kind: DomReadKind.Attribute, name: assertion.name };
    default: return null;
  }
}

// A DOM check on the one element found. A probe that read nothing, or read something else, fails
// the check: it never passes by accident. Values are compared exactly, as the page holds them;
// only a computed style has its white space normalised, since browsers space their own text.
function checkDom(assertion: DomCheckWith<SafeText>, probe: OneElementRead): Verdict {
  const read = probe.dom;
  switch (assertion.kind) {
    case DomCheckKind.HasClass: case DomCheckKind.LacksClass: {
      if (read?.kind !== DomReadKind.Classes) return FAILED;
      return read.classes.includes(assertion.value) === (assertion.kind === DomCheckKind.HasClass) ? PASSED : FAILED;
    }
    case DomCheckKind.ComputedStyleEquals:
      return read?.kind === DomReadKind.ComputedStyle && normalise(read.value) === normalise(assertion.value) ? PASSED : FAILED;
    case DomCheckKind.AttributeEquals: return read?.kind === DomReadKind.Attribute && read.value === assertion.value ? PASSED : FAILED;
    case DomCheckKind.AttributeAbsent: return read?.kind === DomReadKind.Attribute && read.value === null ? PASSED : FAILED;
  }
}

// Collapses runs of white space and trims, so layout white space never decides a text check.
export const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Each accessibility state check: the state it reads, and the value that passes it.
const STATE_CHECKS = {
  selected: ['selected', true], unselected: ['selected', false],
  expanded: ['expanded', true], collapsed: ['expanded', false],
  pressed: ['pressed', true], unpressed: ['pressed', false],
  current: ['current', true],
} as const satisfies Record<string, readonly [keyof AccessibleStates, boolean]>;

// A state check passes only on an element that exposes the state.
function checkState(kind: keyof typeof STATE_CHECKS, probe: OneElementRead): Verdict {
  const [state, wanted] = STATE_CHECKS[kind];
  const exposed = probe.states[state];
  if (exposed === null) return STATE_NOT_EXPOSED;
  return exposed === wanted ? PASSED : FAILED;
}

// The absolute URL a text names, resolved against the base URL when it is a path; undefined when
// it is no URL.
function absoluteUrl(text: string, baseUrl: string | undefined): string | undefined {
  try {
    return (baseUrl === undefined ? new URL(text) : new URL(text, baseUrl)).href;
  } catch {
    return undefined;
  }
}

// Two URLs are the same when both parse and their normalised forms are equal.
function sameUrl(expected: string, actual: string | null | undefined, baseUrl: string | undefined): boolean {
  if (actual === null || actual === undefined) return false;
  const wanted = absoluteUrl(expected, baseUrl);
  const seen = absoluteUrl(actual, undefined);
  return wanted !== undefined && wanted === seen;
}

// The assertion's expected text is final: the run replaces value references before checking.
// `baseUrl` is the run's base URL, which an expected link target given as a path is resolved on.
export function checkElement(assertion: ResolvedElementAssertion, probe: ElementProbe, baseUrl?: string): Verdict {
  // A page that cannot be read, and a selector the browser rejects, which matches nothing, say
  // nothing of how many elements there are: no check passes on them, absent included.
  if (typeof probe.count === 'string') {
    return { pass: false, code: probe.count };
  }
  // Checks on how many elements match come before the single-element rule below.
  if (assertion.kind === ElementStateKind.Absent) return probe.count === 0 ? PASSED : FAILED;
  if (assertion.kind === ElementAssertionKind.CountEquals) return probe.count === assertion.value ? PASSED : FAILED;
  if (assertion.kind === ElementAssertionKind.Hidden && probe.count === 0) {
    return PASSED;
  }
  const found = oneElementOf(probe);
  if (!found.ok) {
    return { pass: false, code: found.error };
  }
  const element = found.value;
  switch (assertion.kind) {
    case ElementAssertionKind.Hidden: return element.visible ? FAILED : PASSED;
    case ElementAssertionKind.Visible: return element.visible ? PASSED : FAILED;
    case ElementAssertionKind.Enabled: return element.enabled ? PASSED : FAILED;
    case ElementAssertionKind.Disabled: return !element.enabled ? PASSED : FAILED;
    case ElementAssertionKind.TextEquals: return normalise(element.text) === normalise(assertion.value) ? PASSED : FAILED;
    case ElementAssertionKind.TextContains: return normalise(element.text).includes(normalise(assertion.value)) ? PASSED : FAILED;
    case ElementAssertionKind.ValueEquals: return element.value === assertion.value ? PASSED : FAILED;
    case ElementAssertionKind.ValueContains: return element.value !== null && element.value.includes(assertion.value) ? PASSED : FAILED;
    case ElementAssertionKind.Selected: case ElementAssertionKind.Unselected: case ElementAssertionKind.Expanded: case ElementAssertionKind.Collapsed: case ElementAssertionKind.Pressed: case ElementAssertionKind.Unpressed: case ElementAssertionKind.Current:
      return checkState(assertion.kind, element);
    // The link's resolved href, never followed. An element in no link fails.
    case ElementAssertionKind.HrefEquals: return sameUrl(assertion.value, element.href, baseUrl) ? PASSED : FAILED;
    // The probe does not report checked or focused state yet, so these checks can never pass by
    // accident. The run refuses them before probing; see isElementCheckNoDriverDecides in the contracts package.
    case ElementAssertionKind.Checked: case ElementAssertionKind.Unchecked: case ElementAssertionKind.Focused:
      return FAILED;
    case ElementAssertionKind.HasClass: case ElementAssertionKind.LacksClass: case ElementAssertionKind.ComputedStyleEquals: case ElementAssertionKind.AttributeEquals: case ElementAssertionKind.AttributeAbsent:
      return checkDom(assertion, element);
  }
}

// HTML meta names are compared without regard to ASCII case.
const sameMetaName = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

// `baseUrl` is the run's base URL, which an expected canonical URL given as a path is resolved on.
export function checkPage(assertion: PageAssertion, probe: PageProbe, baseUrl?: string): Verdict {
  if (probe.browserErrorPage === true) {
    return NAVIGATION_FAILED;
  }
  switch (assertion.kind) {
    case PageTextKind.UrlPath: return new URL(probe.url).pathname === assertion.value ? PASSED : FAILED;
    case PageTextKind.Title: return normalise(probe.title) === normalise(assertion.value) ? PASSED : FAILED;
    // The expected URL may be a path; it is resolved against the page's URL before comparing.
    case PageAssertionKind.Url: return new URL(assertion.value, probe.url).href === new URL(probe.url).href ? PASSED : FAILED;
    // A plain text prefix of the path: the query and fragment are not part of it.
    case PageAssertionKind.UrlPathStartsWith: return new URL(probe.url).pathname.startsWith(assertion.value) ? PASSED : FAILED;
    // Passes when a meta tag of that name or property has the content. A head with no such tag
    // fails. A value reference left in the check never matches.
    case PageAssertionKind.MetaContent: {
      const expected = literalText(assertion.value);
      if (expected === undefined) return FAILED;
      const found = probe.meta.some((tag) => sameMetaName(tag.name, assertion.name) && normalise(tag.content) === normalise(expected));
      return found ? PASSED : FAILED;
    }
    // A head with no canonical link fails, even against the page's own URL.
    case PageAssertionKind.CanonicalUrl: return sameUrl(assertion.value, probe.canonicalUrl, baseUrl) ? PASSED : FAILED;
  }
}
