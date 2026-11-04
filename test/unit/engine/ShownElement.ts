// The probes, verdicts and text the tests of the oracle share.
import assert from "node:assert/strict";
import {
    runTimeText,
    type AccessibleStates,
    type ElementProbe,
    type ResolvedElementAssertion,
    type SafeText,
    type UnreadablePage,
    type Verdict,
} from "@revisum/engine";

export const BASE_URL = "https://shop.example.test";
export const ORDERS_URL = `${BASE_URL}/orders`;

export const PASSED: Verdict = { pass: true, code: null };
export const FAILED: Verdict = { pass: false, code: "assertion-failed" };
export const NOT_FOUND: Verdict = { pass: false, code: "not-found" };
export const AMBIGUOUS: Verdict = { pass: false, code: "ambiguous" };
export const STATE_NOT_EXPOSED: Verdict = { pass: false, code: "state-not-exposed" };
export const SELECTOR_INVALID: Verdict = { pass: false, code: "selector-invalid" };

export function safe(text: string): SafeText {
    const checked = runTimeText(text, 1000);
    assert.ok(checked !== undefined, `the test's text is safe: ${text}`);
    return checked;
}

export type ReadElements = Extract<ElementProbe, { readonly count: number }>;

export const SHOWN_ELEMENT: ReadElements = {
    count: 1,
    visible: true,
    enabled: true,
    text: "Order  placed",
    value: "Ada Lovelace",
    sensitive: false,
    box: null,
};
export const NOTHING: ReadElements = {
    ...SHOWN_ELEMENT,
    count: 0,
    visible: false,
    text: "",
    value: null,
};
export const NOT_SHOWN: ReadElements = { ...SHOWN_ELEMENT, visible: false };
export const DISABLED: ReadElements = { ...SHOWN_ELEMENT, enabled: false };
export const NO_VALUE: ReadElements = { ...SHOWN_ELEMENT, value: null };
export const REJECTED_SELECTOR: ReadElements = { ...NOTHING, selectorInvalid: true };
export const unreadable = (count: UnreadablePage): ElementProbe => ({ count });
export const twoOf = (probe: ReadElements): ReadElements => ({ ...probe, count: 2 });
export const statesOf = (states: Partial<AccessibleStates>): ElementProbe => ({
    ...SHOWN_ELEMENT,
    states: { selected: null, expanded: null, pressed: null, current: null, ...states },
});

export const ABSENT: ResolvedElementAssertion = { kind: "absent" };
export const HIDDEN: ResolvedElementAssertion = { kind: "hidden" };
export const VISIBLE: ResolvedElementAssertion = { kind: "visible" };
export const COUNT_OF_NONE: ResolvedElementAssertion = { kind: "countEquals", value: 0 };

export const verdictName = (verdict: Verdict): string =>
    verdict.pass ? "a pass" : String(verdict.code);
