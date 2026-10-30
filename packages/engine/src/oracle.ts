// The assertion oracle: pure functions from a probe to a verdict. It lives in the engine so that
// neither a driver nor an AI can change what "passed" means.
import { literalText, type AccessibleStates, type ElementProbe, type PageAssertion, type PageProbe, type ResolvedElementAssertion } from '@revisum/contracts';

// state-not-exposed: the element does not expose the state a check asks about, so the check can
// neither pass nor fail on its merits.
export type Verdict = { readonly pass: boolean; readonly code: 'not-found' | 'ambiguous' | 'assertion-failed' | 'state-not-exposed' | null };

const PASSED: Verdict = { pass: true, code: null };
const FAILED: Verdict = { pass: false, code: 'assertion-failed' };
const NOT_FOUND: Verdict = { pass: false, code: 'not-found' };
const AMBIGUOUS: Verdict = { pass: false, code: 'ambiguous' };
const STATE_NOT_EXPOSED: Verdict = { pass: false, code: 'state-not-exposed' };

// Collapses runs of white space and trims, so layout white space never decides a text check.
export const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Each accessibility state check: the state it reads, and the value that passes it.
const STATE_CHECKS = {
  selected: ['selected', true], unselected: ['selected', false],
  expanded: ['expanded', true], collapsed: ['expanded', false],
  pressed: ['pressed', true], unpressed: ['pressed', false],
  current: ['current', true],
} as const satisfies Record<string, readonly [keyof AccessibleStates, boolean]>;

// A state check passes only on an element that exposes the state; a probe with no states at all
// exposes none, so the check never passes by accident.
function checkState(kind: keyof typeof STATE_CHECKS, probe: ElementProbe): Verdict {
  const [state, wanted] = STATE_CHECKS[kind];
  const exposed = probe.states?.[state] ?? null;
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
  // Checks on how many elements match come before the single-element rule below.
  if (assertion.kind === 'absent') return probe.count === 0 ? PASSED : FAILED;
  if (assertion.kind === 'countEquals') return probe.count === assertion.value ? PASSED : FAILED;
  if (assertion.kind === 'hidden') {
    if (probe.count === 0 || (probe.count === 1 && !probe.visible)) return PASSED;
    return probe.count > 1 ? AMBIGUOUS : FAILED;
  }
  if (probe.count === 0) return NOT_FOUND;
  if (probe.count > 1) return AMBIGUOUS;
  switch (assertion.kind) {
    case 'visible': return probe.visible ? PASSED : FAILED;
    case 'enabled': return probe.enabled ? PASSED : FAILED;
    case 'disabled': return !probe.enabled ? PASSED : FAILED;
    case 'textEquals': return normalise(probe.text) === normalise(assertion.value) ? PASSED : FAILED;
    case 'textContains': return normalise(probe.text).includes(normalise(assertion.value)) ? PASSED : FAILED;
    case 'valueEquals': return probe.value === assertion.value ? PASSED : FAILED;
    case 'valueContains': return probe.value !== null && probe.value.includes(assertion.value) ? PASSED : FAILED;
    case 'selected': case 'unselected': case 'expanded': case 'collapsed': case 'pressed': case 'unpressed': case 'current':
      return checkState(assertion.kind, probe);
    // The link's resolved href, never followed. An element in no link fails.
    case 'hrefEquals': return sameUrl(assertion.value, probe.href, baseUrl) ? PASSED : FAILED;
    // The probe does not report checked or focused state yet, so these checks can never pass by
    // accident. The run refuses them before probing; see needsDriverFeatures in the contracts package.
    case 'checked': case 'unchecked': case 'focused':
      return FAILED;
  }
}

// HTML meta names are compared without regard to ASCII case.
const sameMetaName = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

// `baseUrl` is the run's base URL, which an expected canonical URL given as a path is resolved on.
export function checkPage(assertion: PageAssertion, probe: PageProbe, baseUrl?: string): Verdict {
  switch (assertion.kind) {
    case 'urlPath': return new URL(probe.url).pathname === assertion.value ? PASSED : FAILED;
    case 'title': return normalise(probe.title) === normalise(assertion.value) ? PASSED : FAILED;
    // The expected URL may be a path; it is resolved against the page's URL before comparing.
    case 'url': return new URL(assertion.value, probe.url).href === new URL(probe.url).href ? PASSED : FAILED;
    // A plain text prefix of the path: the query and fragment are not part of it.
    case 'urlPathStartsWith': return new URL(probe.url).pathname.startsWith(assertion.value) ? PASSED : FAILED;
    // Passes when a meta tag of that name or property has the content. A head with no such tag,
    // or a probe that read no head, fails. A value reference left in the check never matches.
    case 'metaContent': {
      const expected = literalText(assertion.value);
      if (expected === undefined) return FAILED;
      const found = (probe.meta ?? []).some((tag) => sameMetaName(tag.name, assertion.name) && normalise(tag.content) === normalise(expected));
      return found ? PASSED : FAILED;
    }
    // A head with no canonical link fails, even against the page's own URL.
    case 'canonicalUrl': return sameUrl(assertion.value, probe.canonicalUrl, baseUrl) ? PASSED : FAILED;
  }
}
