// The assertion oracle: pure functions from a probe to a verdict. It lives in the engine so that
// neither a driver nor an AI can change what "passed" means.
import type { ElementProbe, PageAssertion, PageProbe, ResolvedElementAssertion } from '@revisum/contracts';

export type Verdict = { readonly pass: boolean; readonly code: 'not-found' | 'ambiguous' | 'assertion-failed' | null };

const PASSED: Verdict = { pass: true, code: null };
const FAILED: Verdict = { pass: false, code: 'assertion-failed' };
const NOT_FOUND: Verdict = { pass: false, code: 'not-found' };
const AMBIGUOUS: Verdict = { pass: false, code: 'ambiguous' };

// Collapses runs of white space and trims, so layout white space never decides a text check.
export const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

// The assertion's expected text is final: the run replaces value references before checking.
export function checkElement(assertion: ResolvedElementAssertion, probe: ElementProbe): Verdict {
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
    // The probe does not report checked or focused state yet, so these checks can never pass by
    // accident. The run refuses them before probing; see UNSUPPORTED_ASSERTION_KINDS in run.ts.
    case 'checked': case 'unchecked': case 'focused': return FAILED;
  }
}

export function checkPage(assertion: PageAssertion, probe: PageProbe): Verdict {
  switch (assertion.kind) {
    case 'urlPath': return new URL(probe.url).pathname === assertion.value ? PASSED : FAILED;
    case 'title': return normalise(probe.title) === normalise(assertion.value) ? PASSED : FAILED;
    // The expected URL may be a path; it is resolved against the page's URL before comparing.
    case 'url': return new URL(assertion.value, probe.url).href === new URL(probe.url).href ? PASSED : FAILED;
    // A plain text prefix of the path: the query and fragment are not part of it.
    case 'urlPathStartsWith': return new URL(probe.url).pathname.startsWith(assertion.value) ? PASSED : FAILED;
  }
}
