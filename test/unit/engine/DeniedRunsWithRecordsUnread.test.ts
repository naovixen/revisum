// A denied run that cannot read a record once its steps have run gives no verdict, so it ends Errored.
// The denial still happened: the guard stopped an irreversible action. So the result keeps it,
// whichever record went unread, exactly as a denied run whose records could all be read gives it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ActionGuard, failure, type RunPorts, type Session, success } from "@revisum/engine";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
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

const UNREAD_RECORDS = [
    {
        name: "behind an egress proxy whose rewrites cannot be read",
        run: () => runDenied(sessionAskingTheGuard(), throws),
    },
    {
        name: "whose blocked origins cannot be read",
        run: () => runDenied(sessionAskingTheGuard({ blockedOrigins: throws })),
    },
];

describe("Using the run", () => {
    describe("given a click the guard denies", () => {
        for (const record of UNREAD_RECORDS) {
            describe(`and a session ${record.name}`, () => {
                describe("when the run ends", () => {
                    test("then it should end Errored and keep the denial a run with sound records gives", async () => {
                        const expected = await denialWithSoundRecords();
                        const { result } = await record.run();
                        assert.equal(result.state, "Errored", JSON.stringify(result.steps));
                        assert.deepEqual(result.denial, expected);
                    });
                });
            });
        }
    });
});
