// A denied run that cannot read a record once its steps have run gives no verdict, so it ends Errored.
// The denial still happened: the guard stopped an irreversible action. So the result keeps it,
// whichever record went unread, exactly as a denied run whose records could all be read gives it,
// and so does the log's last word on how the run ended.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    type ActionGuard,
    failure,
    type RunEventSink,
    type RunPorts,
    type Session,
    success,
} from "@revisum/engine";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { sessionRecords } from "#test-support/fakes/FakeSession.ts";
import { fakeSessionOnOrders, runOnFakeSession } from "./RunOnFakeSession.ts";
import {
    OPEN_CART,
    unsafePlan,
    unsafeProjectFile,
    type JsonRecord,
} from "./unsafe-feature-steps.ts";

// In English, so the guard's built-in irreversible patterns apply.
const PROJECT_FILE = unsafeProjectFile(undefined, {
    matrix: englishMatrix([BrowserTarget.Chrome]),
});

// A test id, so only the run-time guard can see what the element is called.
const DELETE_ACCOUNT: JsonRecord = {
    type: "click",
    locator: { by: "testId", testId: "danger-zone" },
};

const throws = (): never => {
    throw new Error("the record could not be read");
};

// A session whose act asks the guard about an element named "Delete account", as a driver must.
const sessionAskingTheGuard = (changes: Partial<Session> = {}): Session =>
    fakeSessionOnOrders({
        act: (step, guard?: ActionGuard) => {
            assert.equal(step.type, "click");
            const verdict = guard?.(
                {
                    role: "button",
                    name: "Delete account",
                    box: null,
                    formSubmitName: null,
                    linkUrl: null,
                },
                null,
            );
            return Promise.resolve(
                verdict?.kind === "deny"
                    ? failure({ code: "policy-denied", detail: "denied" })
                    : success(undefined),
            );
        },
        ...changes,
    });

const runDenied = (session: Session, rewritesApplied: RunPorts["rewritesApplied"] = () => []) =>
    runOnFakeSession(unsafePlan([OPEN_CART, DELETE_ACCOUNT]), {
        projectFile: PROJECT_FILE,
        session,
        rewritesApplied,
    });

// The denial a denied run gives when every record can be read.
async function denialWithSoundRecords() {
    const { result } = await runDenied(sessionAskingTheGuard());
    assert.equal(result.state, "Denied", JSON.stringify(result.steps));
    return result.denial;
}

// The state, code and step the log's last run.state entry gives, read as plain data so the entry's
// own type does not decide which fields it may hold.
const lastRunStateLogged = (events: RunEventSink): Readonly<Record<string, unknown>> => {
    const last = events
        .read()
        .filter((event) => event.kind === "run.state")
        .at(-1);
    assert.ok(last !== undefined, "the log holds no run.state entry");
    return Object.fromEntries(
        Object.entries(last).filter(([field]) => ["state", "code", "stepIndex"].includes(field)),
    );
};

const UNREAD_RECORDS = [
    {
        name: "behind an egress proxy whose rewrites cannot be read",
        run: () => runDenied(sessionAskingTheGuard(), throws),
    },
    {
        name: "whose blocked origins cannot be read",
        run: () =>
            runDenied(
                sessionAskingTheGuard({
                    recordsSoFar: () =>
                        sessionRecords({ blockedOrigins: failure("the record could not be read") }),
                }),
            ),
    },
];

describe("Using the run", () => {
    describe("given a click the guard denies", () => {
        describe("and a session whose records can all be read", () => {
            describe("when the run ends", () => {
                test("then it should log Denied as the run's last state, with the denial's rule and step", async () => {
                    const { result, events } = await runDenied(sessionAskingTheGuard());
                    assert.equal(result.state, "Denied", JSON.stringify(result.steps));
                    assert.deepEqual(lastRunStateLogged(events), {
                        state: "Denied",
                        code: result.denial.rule,
                        stepIndex: result.denial.stepIndex,
                    });
                });
            });
        });

        for (const record of UNREAD_RECORDS) {
            describe(`and a session ${record.name}`, () => {
                describe("when the run ends", () => {
                    test("then it should end Errored and keep the denial a run with sound records gives", async () => {
                        const expected = await denialWithSoundRecords();
                        const { result } = await record.run();
                        assert.equal(result.state, "Errored", JSON.stringify(result.steps));
                        assert.deepEqual(result.denial, expected);
                    });

                    test("then it should log Errored as the run's last state, with the denial's rule and step", async () => {
                        const expected = await denialWithSoundRecords();
                        const { events } = await record.run();
                        assert.deepEqual(lastRunStateLogged(events), {
                            state: "Errored",
                            code: expected.rule,
                            stepIndex: expected.stepIndex,
                        });
                    });
                });
            });
        }
    });
});
