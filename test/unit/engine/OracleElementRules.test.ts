// The rules that hold across the oracle's element checks: a state is read only where it is exposed,
// one element means one, and a page that can't be read is never an empty page.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UnreadablePage, checkElement, type ResolvedElementAssertion } from "@revisum/engine";
import {
    ABSENT,
    AMBIGUOUS,
    BASE_URL,
    COUNT_OF_NONE,
    FAILED,
    HIDDEN,
    NOTHING,
    NOT_FOUND,
    ORDERS_URL,
    PASSED,
    REJECTED_SELECTOR,
    SELECTOR_INVALID,
    SHOWN_ELEMENT,
    STATE_NOT_EXPOSED,
    VISIBLE,
    safe,
    statesOf,
    twoOf,
    unreadable,
} from "./ShownElement.ts";

const STATE_CHECKS = [
    { kind: "selected", state: "selected", isPassingState: true },
    { kind: "unselected", state: "selected", isPassingState: false },
    { kind: "expanded", state: "expanded", isPassingState: true },
    { kind: "collapsed", state: "expanded", isPassingState: false },
    { kind: "pressed", state: "pressed", isPassingState: true },
    { kind: "unpressed", state: "pressed", isPassingState: false },
] as const;

// Every check of one element, so each is held to the single-element rule.
const SINGLE_ELEMENT_CHECKS: readonly ResolvedElementAssertion[] = [
    VISIBLE,
    { kind: "enabled" },
    { kind: "disabled" },
    { kind: "textEquals", value: safe("Order placed") },
    { kind: "textContains", value: safe("Order") },
    { kind: "valueEquals", value: safe("Ada Lovelace") },
    { kind: "valueContains", value: safe("Ada") },
    { kind: "hrefEquals", value: safe("/orders") },
    { kind: "selected" },
    { kind: "checked" },
    { kind: "hasClass", value: safe("is-active") },
    { kind: "attributeAbsent", name: safe("disabled") },
];

describe("Using the oracle", () => {
    describe("given a hrefEquals check of a path and no base URL", () => {
        describe("when the element is judged", () => {
            test("then it should fail, since the path can't be read as a URL", () => {
                assert.deepEqual(
                    checkElement(
                        { kind: "hrefEquals", value: safe("/orders") },
                        { ...SHOWN_ELEMENT, href: ORDERS_URL },
                    ),
                    FAILED,
                );
            });
        });
    });

    describe("given a hrefEquals check of a whole URL and no base URL", () => {
        describe("when the element is judged", () => {
            test("then it should pass on a link to it", () => {
                assert.deepEqual(
                    checkElement(
                        { kind: "hrefEquals", value: safe(ORDERS_URL) },
                        { ...SHOWN_ELEMENT, href: ORDERS_URL },
                    ),
                    PASSED,
                );
            });
        });
    });

    for (const { kind, state, isPassingState } of STATE_CHECKS) {
        describe(`given a ${kind} check`, () => {
            describe("and an element whose state matches", () => {
                describe("when the element is judged", () => {
                    test("then it should pass", () => {
                        assert.deepEqual(
                            checkElement({ kind }, statesOf({ [state]: isPassingState })),
                            PASSED,
                        );
                    });
                });
            });

            describe("and an element whose state differs", () => {
                describe("when the element is judged", () => {
                    test("then it should fail with assertion-failed", () => {
                        assert.deepEqual(
                            checkElement({ kind }, statesOf({ [state]: !isPassingState })),
                            FAILED,
                        );
                    });
                });
            });

            describe("and an element that does not expose the state", () => {
                describe("when the element is judged", () => {
                    test("then it should fail with state-not-exposed", () => {
                        assert.deepEqual(checkElement({ kind }, statesOf({})), STATE_NOT_EXPOSED);
                    });
                });
            });

            describe("and a driver that reads no states", () => {
                describe("when the element is judged", () => {
                    test("then it should fail with state-not-exposed", () => {
                        assert.deepEqual(checkElement({ kind }, SHOWN_ELEMENT), STATE_NOT_EXPOSED);
                    });
                });
            });
        });
    }

    describe("given a current check", () => {
        describe("and an element that is current", () => {
            describe("when the element is judged", () => {
                test("then it should pass", () => {
                    assert.deepEqual(
                        checkElement({ kind: "current" }, statesOf({ current: true })),
                        PASSED,
                    );
                });
            });
        });

        describe("and an element that is not current", () => {
            describe("when the element is judged", () => {
                test("then it should fail with assertion-failed", () => {
                    assert.deepEqual(
                        checkElement({ kind: "current" }, statesOf({ current: false })),
                        FAILED,
                    );
                });
            });
        });
    });

    for (const kind of ["checked", "unchecked", "focused"] as const) {
        describe(`given a ${kind} check, which no probe can report`, () => {
            describe("when an element is judged", () => {
                test("then it should fail with assertion-failed", () => {
                    assert.deepEqual(checkElement({ kind }, SHOWN_ELEMENT), FAILED);
                });
            });
        });
    }

    for (const assertion of SINGLE_ELEMENT_CHECKS) {
        describe(`given a ${assertion.kind} check of one element`, () => {
            describe("and no element", () => {
                describe("when the element is judged", () => {
                    test("then it should fail with not-found", () => {
                        assert.deepEqual(checkElement(assertion, NOTHING, BASE_URL), NOT_FOUND);
                    });
                });
            });

            describe("and two elements", () => {
                describe("when the element is judged", () => {
                    test("then it should fail with ambiguous", () => {
                        assert.deepEqual(
                            checkElement(assertion, twoOf(SHOWN_ELEMENT), BASE_URL),
                            AMBIGUOUS,
                        );
                    });
                });
            });

            describe("and a rejected selector", () => {
                describe("when the element is judged", () => {
                    test("then it should fail with selector-invalid", () => {
                        assert.deepEqual(
                            checkElement(assertion, REJECTED_SELECTOR, BASE_URL),
                            SELECTOR_INVALID,
                        );
                    });
                });
            });
        });
    }

    for (const count of Object.values(UnreadablePage)) {
        for (const assertion of [ABSENT, HIDDEN, COUNT_OF_NONE, VISIBLE]) {
            describe(`given a ${assertion.kind} check and a page that gives ${count}`, () => {
                describe("when the element is judged", () => {
                    test(`then it should fail with ${count}, never as an empty page`, () => {
                        assert.deepEqual(checkElement(assertion, unreadable(count)), {
                            pass: false,
                            code: count,
                        });
                    });
                });
            });
        }
    }
});
