// The probes, verdicts and text the tests of the oracle share.
import assert from "node:assert/strict";
import {
    runTimeText,
    type AccessibleStates,
    type ElementProbe,
    type ElementsRead,
    type OneElementRead,
    type ResolvedElementAssertion,
    type SafeText,
    type UnreadablePage,
    type Verdict,
} from "@revisum/engine";
import { severalElements } from "#test-support/fakes/session/SeveralElements.ts";
import { ElementStateKind } from "@revisum/contracts";

export const BASE_URL = "https://shop.example.test";
export const ORDERS_URL = `${BASE_URL}/orders`;

export const PASSED: Verdict = { pass: true };
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

export const SHOWN_ELEMENT: OneElementRead = {
    count: 1,
    visible: true,
    enabled: true,
    text: "Order  placed",
    value: "Ada Lovelace",
    sensitive: false,
    box: null,
    states: { selected: null, expanded: null, pressed: null, current: null },
    href: null,
};
export const NOTHING: ElementsRead = { count: 0 };
export const NOT_SHOWN: OneElementRead = { ...SHOWN_ELEMENT, visible: false };
export const DISABLED: OneElementRead = { ...SHOWN_ELEMENT, enabled: false };
export const NO_VALUE: OneElementRead = { ...SHOWN_ELEMENT, value: null };
export const REJECTED_SELECTOR: ElementProbe = { count: "selector-invalid" };
export const unreadable = (count: UnreadablePage): ElementProbe => ({ count });
export const TWO_ELEMENTS: ElementsRead = { count: severalElements(2) };
export const statesOf = (states: Partial<AccessibleStates>): ElementProbe => ({
    ...SHOWN_ELEMENT,
    states: { selected: null, expanded: null, pressed: null, current: null, ...states },
});

export const ABSENT: ResolvedElementAssertion = { kind: ElementStateKind.Absent };
export const HIDDEN: ResolvedElementAssertion = { kind: ElementStateKind.Hidden };
export const VISIBLE: ResolvedElementAssertion = { kind: ElementStateKind.Visible };
export const COUNT_OF_NONE: ResolvedElementAssertion = { kind: "countEquals", value: 0 };

export const verdictName = (verdict: Verdict): string =>
    verdict.pass ? "a pass" : String(verdict.code);
