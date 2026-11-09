// What a storage check decides from the value it reads, with no browser. An entry holding the empty
// string is present, not absent. What a failed check says about the entry never includes its value.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { failure, success, type RunResult, type StoragePort } from "@revisum/engine";
import { fakeSessionOnOrders, runOnFakeSession } from "../../examples/RunOnFakeSession.ts";
import { ORIGIN } from "../../values/examples/RunPlan.ts";
import { expectStorage } from "./examples/Stubs.ts";
import {
    OPEN_CART,
    unsafePlan,
    type JsonRecord,
} from "../../../plan/unsafe-features/examples/UnsafePlan.ts";
import { fakeStoragePort } from "#test-support/fakes/ports/FakeStoragePort.ts";
import { StepType } from "@revisum/contracts";

const STORED_VALUE = "stored-value";
const EQUALS_STORED_VALUE: JsonRecord = { kind: "equals", value: STORED_VALUE };

const storageCheckOf = (result: RunResult) => {
    const step = result.steps.find((candidate) => candidate.type === StepType.ExpectStorage);
    assert.ok(step !== undefined, "the plan holds a storage check");
    return { outcome: step.outcome, code: step.code, observed: step.observed };
};

const runCheck = async (assertion: JsonRecord, read: StoragePort["read"]) => {
    const { result } = await runOnFakeSession(
        unsafePlan([OPEN_CART, expectStorage("privateKey", assertion)]),
        { session: fakeSessionOnOrders({ storage: fakeStoragePort({ read }) }) },
    );
    return storageCheckOf(result);
};

const PASSED = { outcome: "passed", code: undefined, observed: undefined };
const failedSeeing = (observed: string) => ({
    outcome: "failed",
    code: "assertion-failed",
    observed,
});

const CASES: readonly {
    readonly check: string;
    readonly assertion: JsonRecord;
    readonly stored: string | null;
    readonly expected: unknown;
}[] = [
    { check: "present", assertion: { kind: "present" }, stored: STORED_VALUE, expected: PASSED },
    { check: "present", assertion: { kind: "present" }, stored: "", expected: PASSED },
    {
        check: "present",
        assertion: { kind: "present" },
        stored: null,
        expected: failedSeeing("absent"),
    },
    { check: "absent", assertion: { kind: "absent" }, stored: null, expected: PASSED },
    {
        check: "absent",
        assertion: { kind: "absent" },
        stored: STORED_VALUE,
        expected: failedSeeing("present"),
    },
    {
        check: "absent",
        assertion: { kind: "absent" },
        stored: "",
        expected: failedSeeing("present"),
    },
    { check: "equals", assertion: EQUALS_STORED_VALUE, stored: STORED_VALUE, expected: PASSED },
    {
        check: "equals",
        assertion: EQUALS_STORED_VALUE,
        stored: STORED_VALUE.toUpperCase(),
        expected: failedSeeing("differs"),
    },
    {
        check: "equals",
        assertion: EQUALS_STORED_VALUE,
        stored: `${STORED_VALUE} `,
        expected: failedSeeing("differs"),
    },
    {
        check: "equals",
        assertion: EQUALS_STORED_VALUE,
        stored: "",
        expected: failedSeeing("differs"),
    },
    {
        check: "equals",
        assertion: EQUALS_STORED_VALUE,
        stored: null,
        expected: failedSeeing("absent"),
    },
];

describe("Using the storage check", () => {
    for (const { check, assertion, stored, expected } of CASES) {
        describe(`given an ${check} check and an entry holding ${JSON.stringify(stored)}`, () => {
            describe("when the run reaches it", () => {
                test(`then it should end ${JSON.stringify(expected)}`, async () => {
                    const seen = await runCheck(assertion, () => Promise.resolve(success(stored)));
                    assert.deepEqual(seen, expected);
                });
            });
        });
    }

    describe("given a declared storage entry", () => {
        describe("when the run reaches its check", () => {
            test("then it should read the declared area, origin and key", async (context) => {
                const read = context.mock.fn<StoragePort["read"]>(() =>
                    Promise.resolve(success(STORED_VALUE)),
                );
                await runCheck({ kind: "present" }, read);
                assert.equal(read.mock.callCount(), 1);
                assert.deepEqual(read.mock.calls[0]?.arguments, ["local", ORIGIN, "E2E.priv_key"]);
            });
        });
    });

    for (const kind of ["present", "absent"]) {
        describe(`given an ${kind} check and a page that will not answer`, () => {
            describe("when the run reaches it", () => {
                test("then it should fail with the driver's code and ask only once", async (context) => {
                    const read = context.mock.fn<StoragePort["read"]>(() =>
                        Promise.resolve(
                            failure({ code: "storage-origin-mismatch", detail: "another origin" }),
                        ),
                    );
                    const seen = await runCheck({ kind }, read);
                    assert.deepEqual(seen, {
                        outcome: "failed",
                        code: "storage-origin-mismatch",
                        observed: undefined,
                    });
                    assert.equal(read.mock.callCount(), 1);
                });
            });
        });
    }
});
