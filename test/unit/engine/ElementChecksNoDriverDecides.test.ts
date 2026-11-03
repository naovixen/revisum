// No driver's probe reports a checked or focused state, so these checks can't be decided on their
// merits. The language keeps them, so a plan holding one still parses, but its run is refused before
// any driver call: no earlier step may act for a check that was always going to fail.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DRIVER_FEATURES } from "@revisum/engine";
import {
    OPEN_ORDERS,
    accepted,
    label,
    parserFor,
    planOf,
    runPlan,
    type JsonRecord,
} from "./run-value-examples.ts";

const CONSENT = label("I agree to the terms");
const ACCEPT_TERMS: JsonRecord = { type: "click", locator: CONSENT };
const checkOf = (kind: string): JsonRecord => ({
    type: "expect",
    locator: CONSENT,
    assert: { kind },
    criterionId: "consent.terms-accepted",
});
const inFrame = (step: JsonRecord): JsonRecord => ({
    type: "frame",
    locator: { by: "testId", testId: "terms-frame" },
    steps: [step],
});
const inNewTab = (step: JsonRecord): JsonRecord => ({
    type: "newTab",
    url: "/orders",
    steps: [step],
});

const PLACES: readonly {
    readonly name: string;
    readonly place: (step: JsonRecord) => JsonRecord;
}[] = [
    { name: "in the plan's own steps", place: (step) => step },
    { name: "inside a frame step", place: inFrame },
    { name: "inside a new tab", place: inNewTab },
];

describe("Using the plan parser", () => {
    for (const kind of ["checked", "unchecked", "focused"]) {
        describe(`given a plan with a "${kind}" check`, () => {
            describe("when it is parsed", () => {
                test("then it should accept the plan", () => {
                    const parsed = accepted(parserFor(), planOf([OPEN_ORDERS, checkOf(kind)]));
                    assert.equal(parsed.steps.length, 3);
                });
            });
        });
    }
});

describe("Using the run", () => {
    for (const kind of ["checked", "unchecked", "focused"]) {
        for (const { name, place } of PLACES) {
            describe(`given a plan with a "${kind}" check ${name}, after steps that act`, () => {
                describe("and a driver that declares every optional feature", () => {
                    describe("when the plan is run", () => {
                        test("then it should refuse the run with element-check-unsupported", async () => {
                            const { result } = await runPlan(
                                planOf([OPEN_ORDERS, ACCEPT_TERMS, place(checkOf(kind))]),
                                { performs: DRIVER_FEATURES },
                            );
                            assert.equal(result.state, "Refused", JSON.stringify(result.steps));
                            assert.deepEqual(result.refusal, {
                                code: "element-check-unsupported",
                            });
                            assert.deepEqual(result.steps, []);
                        });

                        test("then it should open no browser and act on no page", async () => {
                            const { recording } = await runPlan(
                                planOf([OPEN_ORDERS, ACCEPT_TERMS, place(checkOf(kind))]),
                                { performs: DRIVER_FEATURES },
                            );
                            assert.equal(recording.environments.length, 0, "a session opened");
                            assert.deepEqual(recording.navigations, []);
                            assert.deepEqual(recording.actions, []);
                            assert.equal(recording.probes, 0);
                        });
                    });
                });
            });
        }
    }

    describe("given a plan with a check a driver can decide", () => {
        describe("when the plan is run", () => {
            test("then it should act, read the page and pass", async () => {
                const { result, recording } = await runPlan(
                    planOf([OPEN_ORDERS, ACCEPT_TERMS, checkOf("visible")]),
                    {
                        performs: DRIVER_FEATURES,
                    },
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.equal(recording.actions.length, 1);
                assert.ok(recording.probes > 0);
            });
        });
    });
});
