// A step has one timeout, whatever it spends the time on. A navigate that loads and then never settles
// has its effect unproved, so it ends as a timeout, as an action does; a selector check that takes most
// of the step leaves only what is left of it to wait for the element, so no step reaches about twice
// its timeout. Time here is mock time, so a step that waits out its timeout costs nothing.
import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import type { DocumentSession, PerformableAction } from "@revisum/engine";
import { navigate } from "#test-support/browser/RawPlan.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { fakeDocumentPorts } from "#test-support/fakes/FakeDocumentPorts.ts";
import { performableActionOf } from "#test-support/PerformableActionOf.ts";
import { allowing, failureCode } from "#test-support/session-contract/SessionUnderTest.ts";
import { accepted, parserFor, planOf } from "../engine/run-value-examples.ts";
import { unsafeSection } from "../engine/unsafe-feature-steps.ts";

const STEP_TIMEOUT_MILLISECONDS = 2000;
// A selector check that leaves almost none of the step for the wait.
const SELECTOR_CHECK_MILLISECONDS = 1800;
// One timeout, a poll and a little: far short of the 3800 ms a second full wait would reach.
const LONGEST_STEP_MILLISECONDS = 2600;
const TICK_MILLISECONDS = 10;
const LONGEST_WAIT_MILLISECONDS = 8000;

const NEVER = (): Promise<never> =>
    new Promise(() => {
        // A page that never answers.
    });

const MISSING = { by: "css", selector: "#not-on-the-page" };

const FIXTURE = "note.txt";
const parsePlan = parserFor({
    fixtures: [FIXTURE],
    unsafeFeatures: unsafeSection(["css-locator"]),
});

// The step as the engine would hand it to a driver, with a CSS locator a project has allowed.
function performableStep(raw: Readonly<Record<string, unknown>>): PerformableAction {
    const [, step] = accepted(parsePlan, planOf([navigate("/"), raw])).steps;
    assert.ok(
        step?.type === "upload" || step?.type === "fill" || step?.type === "click",
        JSON.stringify(step),
    );
    return performableActionOf(step);
}

const ELEMENT_ACTIONS: readonly {
    readonly name: string;
    readonly action: () => PerformableAction;
}[] = [
    {
        name: "an upload",
        action: () => performableStep({ type: "upload", locator: MISSING, fixture: FIXTURE }),
    },
    {
        name: "a fill",
        action: () => performableStep({ type: "fill", locator: MISSING, value: "text" }),
    },
    {
        name: "a click",
        action: () => performableStep({ type: "click", locator: MISSING }),
    },
];

type Timed<Value> = { readonly value: Value; readonly elapsed: number };

// Runs `start` in mock time, ticking until what it gives has settled, and says how much mock time
// that took. A step that never settles fails the test instead of hanging it.
async function inMockTime<Value>(
    context: TestContext,
    start: () => Promise<Value>,
): Promise<Timed<Value>> {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const progress = { isSettled: false };
    const work = start().finally(() => {
        progress.isSettled = true;
    });
    let elapsed = 0;
    while (!progress.isSettled && elapsed < LONGEST_WAIT_MILLISECONDS) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
        context.mock.timers.tick(TICK_MILLISECONDS);
        elapsed += TICK_MILLISECONDS;
    }
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
    assert.ok(progress.isSettled, `the step had not ended after ${elapsed} ms of mock time`);
    return { value: await work, elapsed };
}

// A page whose selector check takes most of the step, and where the element is never found.
const documentWithASlowSelectorCheck = (): DocumentSession =>
    fakeDocumentPorts({
        timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        operations: {
            callForString: () =>
                new Promise((resolve) => {
                    setTimeout(resolve, SELECTOR_CHECK_MILLISECONDS, "valid");
                }),
        },
    });

describe("Using a document's ports", () => {
    for (const { name, action } of ELEMENT_ACTIONS) {
        describe(`given ${name} whose selector check takes most of the step`, () => {
            describe("and an element that is never found", () => {
                describe("when it runs", () => {
                    test("then it should end not-found within the step's one deadline", async (context) => {
                        const { value, elapsed } = await inMockTime(context, () =>
                            documentWithASlowSelectorCheck().act(action(), allowing().guard),
                        );
                        assert.equal(failureCode(value), "not-found");
                        assert.ok(
                            elapsed <= LONGEST_STEP_MILLISECONDS,
                            `the step took ${elapsed} ms of mock time`,
                        );
                    });
                });
            });
        });
    }

    describe("given a navigate that loads and then never settles", () => {
        describe("when it runs", () => {
            test("then it should end as a timeout", async (context) => {
                const { value } = await inMockTime(context, () =>
                    fakeDocumentPorts({
                        timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
                        operations: { twoFramesLater: NEVER },
                    }).navigate("/", scriptsEnabled),
                );
                assert.equal(failureCode(value), "timeout");
            });
        });
    });

    describe("given a navigate that loads and settles", () => {
        describe("when it runs", () => {
            test("then it should succeed", async (context) => {
                const { value } = await inMockTime(context, () =>
                    fakeDocumentPorts({ timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS }).navigate(
                        "/",
                        scriptsEnabled,
                    ),
                );
                assert.deepEqual(value, { ok: true, value: undefined });
            });
        });
    });
});
