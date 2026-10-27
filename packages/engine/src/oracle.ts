// The assertion oracle: pure functions from a probe to a verdict. It lives in the engine so that
// neither a driver nor an AI can change what "passed" means.
import type { ElementAssertion, ElementProbe, PageAssertion, PageProbe } from '@revisum/contracts';

export type Verdict = { readonly pass: boolean; readonly code: 'not-found' | 'ambiguous' | 'assertion-failed' | null };

const PASSED: Verdict = { pass: true, code: null };
const FAILED: Verdict = { pass: false, code: 'assertion-failed' };
const NOT_FOUND: Verdict = { pass: false, code: 'not-found' };
const AMBIGUOUS: Verdict = { pass: false, code: 'ambiguous' };

// Collapses runs of white space and trims, so layout white space never decides a text check.
export const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function checkElement(assertion: ElementAssertion, probe: ElementProbe): Verdict {
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
  }
}

export function checkPage(assertion: PageAssertion, probe: PageProbe): Verdict {
  switch (assertion.kind) {
    case 'urlPath': return new URL(probe.url).pathname === assertion.value ? PASSED : FAILED;
    case 'title': return normalise(probe.title) === normalise(assertion.value) ? PASSED : FAILED;
  }
}
