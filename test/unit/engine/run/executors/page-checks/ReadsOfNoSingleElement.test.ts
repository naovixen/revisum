// A DOM read belongs to one element. A driver's type says so, but the run must hold even against a
// driver that breaks it: what a read of no single element carries reaches neither a DOM check nor a
// remembered value, or a value could come from an element the plan never singled out.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    checkElement,
    sha256,
    type DomRead,
    type DomValue,
    type ElementProbe,
    type ElementsRead,
    type Locator,
    type ResolvedElementAssertion,
} from "@revisum/engine";
import { fakeSessionOnOrders, runOnFakeSession } from "../../examples/RunOnFakeSession.ts";
import {
    AMBIGUOUS,
    NOTHING,
    NOT_FOUND,
    PASSED,
    REJECTED_SELECTOR,
    SHOWN_ELEMENT,
    safe,
    TWO_ELEMENTS,
} from "../../examples/ShownElement.ts";
import {
    OPEN_CART,
    REMEMBER_ATTRIBUTE,
    unsafePlan,
} from "../../../plan/unsafe-features/examples/UnsafePlan.ts";
import { FAKE_ELEMENT } from "#test-support/fakes/session/FakePage.ts";
import { SemanticLocatorKind, DomReadKind } from "@revisum/contracts";

// The spread gets past the type, which refuses dom written on such a read: this is a faulty driver.
const carryingDom = (read: ElementsRead, dom: DomValue): ElementsRead => {
    const carried = { dom };
    return { ...read, ...carried };
};

const REMEMBER_STEP_INDEX = 1;
const ORDER_ID = "ORD-7";
const ATTRIBUTE_READ: DomRead = { kind: DomReadKind.Attribute, name: "data-order-id" };
const ORDER_ID_ATTRIBUTE: DomValue = { kind: DomReadKind.Attribute, value: ORDER_ID };

// Each check with a DOM read it would pass on, were that read of one element.
const DOM_CHECKS: readonly {
    readonly assertion: ResolvedElementAssertion;
    readonly passingRead: DomValue;
}[] = [
    {
        assertion: { kind: "hasClass", value: safe("is-active") },
        passingRead: { kind: DomReadKind.Classes, classes: ["is-active"] },
    },
    {
        assertion: { kind: "lacksClass", value: safe("is-empty") },
        passingRead: { kind: DomReadKind.Classes, classes: [] },
    },
    {
        assertion: {
            kind: "computedStyleEquals",
            property: safe("color"),
            value: safe("rgb(1, 2, 3)"),
        },
        passingRead: { kind: DomReadKind.ComputedStyle, value: "rgb(1, 2, 3)" },
    },
    {
        assertion: { kind: "attributeEquals", name: safe("aria-sort"), value: safe("ascending") },
        passingRead: { kind: DomReadKind.Attribute, value: "ascending" },
    },
    {
        assertion: { kind: "attributeAbsent", name: safe("disabled") },
        passingRead: { kind: DomReadKind.Attribute, value: null },
    },
];

// A run whose one element gives this read, and every DOM read the run asked of the element.
async function rememberAttributeFrom(read: ElementProbe) {
    const asked: (DomRead | null)[] = [];
    const probe = (locator: Locator, domRead: DomRead | null): Promise<ElementProbe> => {
        if (locator.by === SemanticLocatorKind.TestId && locator.testId === "order-row") {
            asked.push(domRead);
        }
        return Promise.resolve(read);
    };
    const ran = await runOnFakeSession(unsafePlan([OPEN_CART, REMEMBER_ATTRIBUTE]), {
        session: fakeSessionOnOrders({ probe }),
    });
    return { ...ran, asked, step: ran.result.steps[REMEMBER_STEP_INDEX] };
}

const hasRememberedAnything = (step: object | undefined): boolean =>
    Object.keys(step ?? {}).some((key) => key.startsWith("remembered"));

describe("Using the oracle", () => {
    for (const { assertion, passingRead } of DOM_CHECKS) {
        describe(`given a ${assertion.kind} check`, () => {
            describe("and a read of one element that satisfies it", () => {
                describe("when the element is judged", () => {
                    test("then it should pass", () => {
                        const read = { ...SHOWN_ELEMENT, dom: passingRead };
                        assert.deepEqual(checkElement(assertion, read), PASSED);
                    });
                });
            });

            describe("and a read of no element that carries a satisfying DOM read", () => {
                describe("when the element is judged", () => {
                    test("then it should fail with not-found", () => {
                        const read = carryingDom(NOTHING, passingRead);
                        assert.deepEqual(checkElement(assertion, read), NOT_FOUND);
                    });
                });
            });

            describe("and a read of two elements that carries a satisfying DOM read", () => {
                describe("when the element is judged", () => {
                    test("then it should fail with ambiguous", () => {
                        const read = carryingDom(TWO_ELEMENTS, passingRead);
                        assert.deepEqual(checkElement(assertion, read), AMBIGUOUS);
                    });
                });
            });
        });
    }
});

describe("Using a run that remembers an attribute of an element", () => {
    const noSingleMatch = [
        { name: "no element", read: NOTHING, code: "not-found" },
        { name: "two elements", read: TWO_ELEMENTS, code: "ambiguous" },
    ];
    for (const { name, read, code } of noSingleMatch) {
        describe(`given a page where the locator finds ${name}`, () => {
            describe("and a driver whose read carries the attribute all the same", () => {
                describe("when the step runs", () => {
                    test(`then it should fail with ${code}, taking no value`, async () => {
                        const { step } = await rememberAttributeFrom(
                            carryingDom(read, ORDER_ID_ATTRIBUTE),
                        );
                        assert.equal(step?.outcome, "failed");
                        assert.equal(step.code, code);
                        assert.equal(hasRememberedAnything(step), false);
                    });

                    test("then it should log no remembered value", async () => {
                        const { events } = await rememberAttributeFrom(
                            carryingDom(read, ORDER_ID_ATTRIBUTE),
                        );
                        assert.equal(
                            events.read().some((event) => event.kind === "value.remembered"),
                            false,
                        );
                    });
                });
            });
        });
    }

    describe("given a page where the locator finds one element with the attribute", () => {
        describe("when the step runs", () => {
            test("then it should remember the attribute's value", async () => {
                const { step } = await rememberAttributeFrom({
                    ...FAKE_ELEMENT,
                    dom: ORDER_ID_ATTRIBUTE,
                });
                assert.equal(step?.outcome, "passed");
                assert.deepEqual(step.remembered, {
                    valueName: "orderId",
                    sha256: sha256(ORDER_ID),
                });
            });

            test("then it should ask the driver for that attribute", async () => {
                const { asked } = await rememberAttributeFrom({
                    ...FAKE_ELEMENT,
                    dom: ORDER_ID_ATTRIBUTE,
                });
                assert.deepEqual(asked, [ATTRIBUTE_READ]);
            });
        });
    });

    const oneElementWithoutTheValue: readonly {
        readonly name: string;
        readonly read: ElementProbe;
    }[] = [
        {
            name: "that lacks the attribute",
            read: { ...FAKE_ELEMENT, dom: { kind: DomReadKind.Attribute, value: null } },
        },
        {
            name: "whose read is of another kind",
            read: { ...FAKE_ELEMENT, dom: { kind: DomReadKind.Classes, classes: [ORDER_ID] } },
        },
        { name: "whose read holds no DOM value", read: FAKE_ELEMENT },
    ];
    for (const { name, read } of oneElementWithoutTheValue) {
        describe(`given a page where the locator finds one element ${name}`, () => {
            describe("when the step runs", () => {
                test("then it should fail with value-empty, taking no value", async () => {
                    const { step } = await rememberAttributeFrom(read);
                    assert.equal(step?.outcome, "failed");
                    assert.equal(step.code, "value-empty");
                    assert.equal(hasRememberedAnything(step), false);
                });
            });
        });
    }

    describe("given a selector the browser rejects", () => {
        describe("when the step runs", () => {
            test("then it should fail with selector-invalid, taking no value", async () => {
                const { step } = await rememberAttributeFrom(REJECTED_SELECTOR);
                assert.equal(step?.outcome, "failed");
                assert.equal(step.code, "selector-invalid");
                assert.equal(hasRememberedAnything(step), false);
            });
        });
    });
});

describe("Using a run of a check", () => {
    describe("given a selector the browser rejects", () => {
        describe("when the check runs", () => {
            test("then it should fail with selector-invalid, having observed no element", async () => {
                const check = {
                    type: "expect",
                    locator: { by: "testId", testId: "status" },
                    assert: { kind: "textEquals", value: "Ready" },
                    criterionId: "status.text-shown",
                };
                const { result } = await runOnFakeSession(unsafePlan([OPEN_CART, check]), {
                    session: fakeSessionOnOrders({
                        probe: () => Promise.resolve(REJECTED_SELECTOR),
                    }),
                });
                const step = result.steps[1];
                assert.ok(step !== undefined, "the check has a result");
                assert.equal(step.code, "selector-invalid");
                assert.equal(step.observed, "(no element)");
            });
        });
    });
});
