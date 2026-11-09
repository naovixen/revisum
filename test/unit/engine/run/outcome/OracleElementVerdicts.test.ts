// What "passed" means is decided in the oracle and nowhere else, so every verdict is held by a fast
// test of it: each check against each kind of probe it can be handed. A negative check is the easiest
// to pass falsely, so it gets the probes that must not satisfy it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    checkElement,
    type ElementProbe,
    type ResolvedElementAssertion,
    type Verdict,
} from "@revisum/engine";
import {
    ABSENT,
    AMBIGUOUS,
    BASE_URL,
    COUNT_OF_NONE,
    DISABLED,
    FAILED,
    HIDDEN,
    NOTHING,
    NOT_FOUND,
    NOT_SHOWN,
    NO_VALUE,
    ORDERS_URL,
    PASSED,
    REJECTED_SELECTOR,
    SELECTOR_INVALID,
    SHOWN_ELEMENT,
    VISIBLE,
    safe,
    TWO_ELEMENTS,
    verdictName,
} from "../examples/ShownElement.ts";
import { DomReadKind, ElementTextKind, ElementStateKind } from "@revisum/contracts";

const ELEMENT_CASES: readonly {
    readonly check: string;
    readonly assertion: ResolvedElementAssertion;
    readonly cases: readonly {
        readonly probe: string;
        readonly seen: ElementProbe;
        readonly verdict: Verdict;
    }[];
}[] = [
    {
        check: "an absent",
        assertion: ABSENT,
        cases: [
            { probe: "no element", seen: NOTHING, verdict: PASSED },
            { probe: "one visible element", seen: SHOWN_ELEMENT, verdict: FAILED },
            { probe: "one element not shown", seen: NOT_SHOWN, verdict: FAILED },
            { probe: "two elements", seen: TWO_ELEMENTS, verdict: FAILED },
            { probe: "a rejected selector", seen: REJECTED_SELECTOR, verdict: SELECTOR_INVALID },
        ],
    },
    {
        check: "a hidden",
        assertion: HIDDEN,
        cases: [
            { probe: "no element", seen: NOTHING, verdict: PASSED },
            { probe: "one element not shown", seen: NOT_SHOWN, verdict: PASSED },
            { probe: "one visible element", seen: SHOWN_ELEMENT, verdict: FAILED },
            { probe: "two elements", seen: TWO_ELEMENTS, verdict: AMBIGUOUS },
            { probe: "a rejected selector", seen: REJECTED_SELECTOR, verdict: SELECTOR_INVALID },
        ],
    },
    {
        check: "a countEquals 0",
        assertion: COUNT_OF_NONE,
        cases: [
            { probe: "no element", seen: NOTHING, verdict: PASSED },
            { probe: "one element", seen: SHOWN_ELEMENT, verdict: FAILED },
            { probe: "a rejected selector", seen: REJECTED_SELECTOR, verdict: SELECTOR_INVALID },
        ],
    },
    {
        check: "a countEquals 2",
        assertion: { kind: "countEquals", value: 2 },
        cases: [
            { probe: "two elements", seen: TWO_ELEMENTS, verdict: PASSED },
            { probe: "one element", seen: SHOWN_ELEMENT, verdict: FAILED },
            { probe: "no element", seen: NOTHING, verdict: FAILED },
        ],
    },
    {
        check: "a visible",
        assertion: VISIBLE,
        cases: [
            { probe: "one visible element", seen: SHOWN_ELEMENT, verdict: PASSED },
            { probe: "one element not shown", seen: NOT_SHOWN, verdict: FAILED },
            { probe: "no element", seen: NOTHING, verdict: NOT_FOUND },
            { probe: "two elements", seen: TWO_ELEMENTS, verdict: AMBIGUOUS },
            { probe: "a rejected selector", seen: REJECTED_SELECTOR, verdict: SELECTOR_INVALID },
        ],
    },
    {
        check: "an enabled",
        assertion: { kind: ElementStateKind.Enabled },
        cases: [
            { probe: "an enabled element", seen: SHOWN_ELEMENT, verdict: PASSED },
            { probe: "a disabled element", seen: DISABLED, verdict: FAILED },
        ],
    },
    {
        check: "a disabled",
        assertion: { kind: ElementStateKind.Disabled },
        cases: [
            { probe: "a disabled element", seen: DISABLED, verdict: PASSED },
            { probe: "an enabled element", seen: SHOWN_ELEMENT, verdict: FAILED },
        ],
    },
    {
        check: "a textEquals with its own spacing",
        assertion: { kind: ElementTextKind.TextEquals, value: safe(" Order placed ") },
        cases: [
            { probe: "the same words, spaced differently", seen: SHOWN_ELEMENT, verdict: PASSED },
            {
                probe: "other words",
                seen: { ...SHOWN_ELEMENT, text: "Order lost" },
                verdict: FAILED,
            },
            {
                probe: "more words",
                seen: { ...SHOWN_ELEMENT, text: "Order placed!" },
                verdict: FAILED,
            },
        ],
    },
    {
        check: "a textContains with its own spacing",
        assertion: { kind: ElementTextKind.TextContains, value: safe("Order   placed") },
        cases: [
            { probe: "the same words, spaced differently", seen: SHOWN_ELEMENT, verdict: PASSED },
            {
                probe: "the words inside more",
                seen: { ...SHOWN_ELEMENT, text: "Your Order placed!" },
                verdict: PASSED,
            },
            {
                probe: "other words",
                seen: { ...SHOWN_ELEMENT, text: "Order lost" },
                verdict: FAILED,
            },
        ],
    },
    {
        check: "a valueEquals",
        assertion: { kind: ElementTextKind.ValueEquals, value: safe("Ada Lovelace") },
        cases: [
            { probe: "that value", seen: SHOWN_ELEMENT, verdict: PASSED },
            {
                probe: "that value spaced differently",
                seen: { ...SHOWN_ELEMENT, value: "Ada  Lovelace" },
                verdict: FAILED,
            },
            { probe: "no value", seen: NO_VALUE, verdict: FAILED },
        ],
    },
    {
        check: "a valueContains",
        assertion: { kind: ElementTextKind.ValueContains, value: safe("Love") },
        cases: [
            { probe: "a value holding it", seen: SHOWN_ELEMENT, verdict: PASSED },
            {
                probe: "a value without it",
                seen: { ...SHOWN_ELEMENT, value: "Ada Byron" },
                verdict: FAILED,
            },
            { probe: "no value", seen: NO_VALUE, verdict: FAILED },
        ],
    },
    {
        check: "a hrefEquals given as a path",
        assertion: { kind: "hrefEquals", value: safe("/orders") },
        cases: [
            {
                probe: "a link to it",
                seen: { ...SHOWN_ELEMENT, href: ORDERS_URL },
                verdict: PASSED,
            },
            {
                probe: "a link elsewhere",
                seen: { ...SHOWN_ELEMENT, href: `${BASE_URL}/cart` },
                verdict: FAILED,
            },
            {
                probe: "an element in no link",
                seen: { ...SHOWN_ELEMENT, href: null },
                verdict: FAILED,
            },
            {
                probe: "a link that is no URL",
                seen: { ...SHOWN_ELEMENT, href: "not a url" },
                verdict: FAILED,
            },
        ],
    },
    {
        check: "a hrefEquals given as a whole URL",
        assertion: { kind: "hrefEquals", value: safe(ORDERS_URL) },
        cases: [
            {
                probe: "a link to it",
                seen: { ...SHOWN_ELEMENT, href: ORDERS_URL },
                verdict: PASSED,
            },
        ],
    },
    {
        check: "a hasClass",
        assertion: { kind: "hasClass", value: safe("is-active") },
        cases: [
            {
                probe: "that class",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Classes, classes: ["is-active"] } },
                verdict: PASSED,
            },
            {
                probe: "other classes",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Classes, classes: ["is-active-now"] } },
                verdict: FAILED,
            },
            { probe: "no DOM read", seen: SHOWN_ELEMENT, verdict: FAILED },
            {
                probe: "another kind of read",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Attribute, value: "is-active" } },
                verdict: FAILED,
            },
        ],
    },
    {
        check: "a lacksClass",
        assertion: { kind: "lacksClass", value: safe("is-empty") },
        cases: [
            {
                probe: "other classes",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Classes, classes: ["is-active"] } },
                verdict: PASSED,
            },
            {
                probe: "that class",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Classes, classes: ["is-empty"] } },
                verdict: FAILED,
            },
            { probe: "no DOM read", seen: SHOWN_ELEMENT, verdict: FAILED },
        ],
    },
    {
        check: "a computedStyleEquals",
        assertion: {
            kind: "computedStyleEquals",
            property: safe("color"),
            value: safe("rgb(1, 2, 3)"),
        },
        cases: [
            {
                probe: "that style, spaced differently",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.ComputedStyle, value: "rgb(1,  2, 3)" } },
                verdict: PASSED,
            },
            {
                probe: "another style",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.ComputedStyle, value: "rgb(9, 9, 9)" } },
                verdict: FAILED,
            },
            { probe: "no DOM read", seen: SHOWN_ELEMENT, verdict: FAILED },
            {
                probe: "another kind of read",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Classes, classes: [] } },
                verdict: FAILED,
            },
        ],
    },
    {
        check: "an attributeEquals",
        assertion: { kind: "attributeEquals", name: safe("aria-sort"), value: safe("ascending") },
        cases: [
            {
                probe: "that value",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Attribute, value: "ascending" } },
                verdict: PASSED,
            },
            {
                probe: "that value spaced differently",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Attribute, value: " ascending" } },
                verdict: FAILED,
            },
            {
                probe: "no such attribute",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Attribute, value: null } },
                verdict: FAILED,
            },
            { probe: "no DOM read", seen: SHOWN_ELEMENT, verdict: FAILED },
        ],
    },
    {
        check: "an attributeAbsent",
        assertion: { kind: "attributeAbsent", name: safe("disabled") },
        cases: [
            {
                probe: "no such attribute",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Attribute, value: null } },
                verdict: PASSED,
            },
            {
                probe: "an empty attribute",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Attribute, value: "" } },
                verdict: FAILED,
            },
            { probe: "no DOM read", seen: SHOWN_ELEMENT, verdict: FAILED },
            {
                probe: "another kind of read",
                seen: { ...SHOWN_ELEMENT, dom: { kind: DomReadKind.Classes, classes: [] } },
                verdict: FAILED,
            },
        ],
    },
];

describe("Using the oracle", () => {
    for (const { check, assertion, cases } of ELEMENT_CASES) {
        for (const { probe, seen, verdict } of cases) {
            describe(`given ${check} check and a probe of ${probe}`, () => {
                describe("when the element is judged", () => {
                    test(`then it should give ${verdictName(verdict)}`, () => {
                        assert.deepEqual(checkElement(assertion, seen, BASE_URL), verdict);
                    });
                });
            });
        }
    }
});
