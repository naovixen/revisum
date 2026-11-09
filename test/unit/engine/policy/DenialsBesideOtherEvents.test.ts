// A denial is the most important thing a run can report: it means the guard stopped an irreversible
// action. Whatever else a driver notices in the same moment, such as a crash or a popup, must not
// turn the run's verdict into an ordinary failure while the audit log holds the denial.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    failure,
    success,
    type ActionGuard,
    type DriverError,
    type Session,
} from "@revisum/engine";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { fakeSessionOnOrders, runOnFakeSession } from "../run/examples/RunOnFakeSession.ts";
import {
    OPEN_CART,
    unsafePlan,
    unsafeProjectFile,
    type JsonRecord,
} from "../plan/unsafe-features/examples/UnsafePlan.ts";

// In English, so the guard's built-in irreversible patterns apply.
const PROJECT_FILE = unsafeProjectFile(undefined, {
    matrix: englishMatrix([BrowserTarget.Chrome]),
});

// A test id, so only the run-time guard can see what the element is called.
const DANGER_ZONE: JsonRecord = { by: "testId", testId: "danger-zone" };
const clickOn = (locator: JsonRecord): JsonRecord => ({ type: "click", locator });

const elementNamed = (name: string) => ({
    role: "button",
    name,
    box: null,
    formSubmitName: null,
    linkUrl: null,
});

// A session whose act asks the guard about the element, as a driver must, then reports `reported`
// whatever the guard said.
const sessionReporting = (reported: DriverError | null, elementName: string): Session =>
    fakeSessionOnOrders({
        act: (step, guard?: ActionGuard) => {
            assert.equal(step.type, "click");
            const verdict = guard?.(elementNamed(elementName), null);
            if (reported !== null) {
                return Promise.resolve(failure(reported));
            }
            return Promise.resolve(
                verdict?.kind === "deny"
                    ? failure({ code: "policy-denied", detail: "denied" })
                    : success(undefined),
            );
        },
    });

// A session that says a request is held only once the denied click has been asked of it, as one would
// that noticed a held request in the same moment as the denial.
function sessionHoldingARequestAfterTheClick(isHeldThen: boolean): Session {
    const reporting = sessionReporting(null, "Delete account");
    let hasClicked = false;
    return {
        ...reporting,
        act: (step, guard) => {
            hasClicked = true;
            return reporting.act(step, guard);
        },
        isRequestHeld: () => isHeldThen && hasClicked,
    };
}

const CRASH: DriverError = { code: "target-crashed", detail: "the page's renderer died" };
const POPUP: DriverError = { code: "unsupported-step", detail: "the step opened a popup" };

describe("Using the run", () => {
    for (const { name, isHeld } of [
        { name: "says a request is held", isHeld: true },
        { name: "says no request is held", isHeld: false },
    ]) {
        describe("given a click the guard denies", () => {
            describe(`and a session that ${name}`, () => {
                describe("when the run ends", () => {
                    test("then it should end Denied with policy-denied", async () => {
                        const { result } = await runOnFakeSession(
                            unsafePlan([OPEN_CART, clickOn(DANGER_ZONE)]),
                            {
                                projectFile: PROJECT_FILE,
                                session: sessionHoldingARequestAfterTheClick(isHeld),
                            },
                        );
                        assert.equal(result.state, "Denied", JSON.stringify(result.steps));
                        assert.equal(result.steps[1]?.code, "policy-denied");
                    });
                });
            });
        });
    }

    for (const { name, reported } of [
        { name: "a crash", reported: CRASH },
        { name: "a popup", reported: POPUP },
    ]) {
        describe("given a click the guard denies", () => {
            describe(`and the driver reports ${name} from the same moment`, () => {
                describe("when the run ends", () => {
                    test("then it should end Denied with policy-denied", async () => {
                        const { result } = await runOnFakeSession(
                            unsafePlan([OPEN_CART, clickOn(DANGER_ZONE)]),
                            {
                                projectFile: PROJECT_FILE,
                                session: sessionReporting(reported, "Delete account"),
                            },
                        );
                        assert.equal(result.state, "Denied", JSON.stringify(result.steps));
                        assert.equal(result.denial.rule, "irreversible-action");
                        assert.equal(
                            result.steps[1]?.code,
                            "policy-denied",
                            JSON.stringify(result.steps),
                        );
                    });
                });
            });
        });

        describe("given a click the guard allows", () => {
            describe(`and the driver reports ${name}`, () => {
                describe("when the run ends", () => {
                    test(`then it should end Failed with ${reported.code}`, async () => {
                        const { result } = await runOnFakeSession(
                            unsafePlan([OPEN_CART, clickOn(DANGER_ZONE)]),
                            {
                                projectFile: PROJECT_FILE,
                                session: sessionReporting(reported, "Save"),
                            },
                        );
                        assert.equal(result.state, "Failed", JSON.stringify(result.steps));
                        assert.equal(
                            result.steps[1]?.code,
                            reported.code,
                            JSON.stringify(result.steps),
                        );
                    });
                });
            });
        });
    }

    describe("given a click the guard denies", () => {
        describe("and nothing else happens", () => {
            describe("when the run ends", () => {
                test("then it should end Denied with policy-denied", async () => {
                    const { result } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, clickOn(DANGER_ZONE)]),
                        {
                            projectFile: PROJECT_FILE,
                            session: sessionReporting(null, "Delete account"),
                        },
                    );
                    assert.equal(result.state, "Denied", JSON.stringify(result.steps));
                    assert.equal(result.steps[1]?.code, "policy-denied");
                });
            });
        });
    });
});
