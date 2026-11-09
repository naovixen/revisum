// A step inside a frame or a second tab does the same work as one at the top of the plan, so what it
// leaves for a person to read must survive: findings, screenshots, downloads, remembered values, a
// page script's record, and the label saying a check ran against a faked answer.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sha256, success } from "@revisum/engine";
import {
    fakeNetwork,
    fakeSessionOnOrders,
    recordsNamed,
    runOnFakeSession,
} from "../examples/RunOnFakeSession.ts";
import { OPEN_CART, READ_CART, unsafePlan, type JsonRecord } from "../../plan/unsafe-features/examples/UnsafePlan.ts";

const STATUS: JsonRecord = { by: "testId", testId: "status" };
const FINDING = { ruleId: "image-alt", impact: "serious", elementCount: 2 } as const;
const FILE_BYTES = new TextEncoder().encode("Report");

const sessionOfOneRun = () =>
    fakeSessionOnOrders({
        audit: () => Promise.resolve(success([FINDING])),
        download: () =>
            Promise.resolve(
                success({
                    fileName: "report.csv",
                    mediaType: "text/csv",
                    bytes: FILE_BYTES,
                    sha256: sha256(FILE_BYTES),
                }),
            ),
        runScript: () => Promise.resolve(success(JSON.stringify({ count: 3 }))),
        network: fakeNetwork(),
    });

const CONTAINERS: readonly {
    readonly name: string;
    readonly around: (steps: readonly JsonRecord[]) => JsonRecord;
}[] = [
    {
        name: "a frame",
        around: (steps) => ({
            type: "frame",
            locator: { by: "testId", testId: "checkout-frame" },
            steps,
        }),
    },
    { name: "a new tab", around: (steps) => ({ type: "newTab", url: "/orders", steps }) },
];

const isRecordHolding = (records: readonly unknown[], expected: JsonRecord): boolean =>
    records
        .flat()
        .some(
            (record) =>
                typeof record === "object" &&
                record !== null &&
                Object.entries(expected).every(
                    ([key, value]) => Object.getOwnPropertyDescriptor(record, key)?.value === value,
                ),
        );

const INNER_STEPS: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly record: string;
    readonly holding: JsonRecord;
}[] = [
    {
        name: "an a11yAudit",
        step: { type: "a11yAudit", mode: "report" },
        record: "findings",
        holding: { ruleId: FINDING.ruleId },
    },
    {
        name: "a capture",
        step: { type: "capture", name: "checkout" },
        record: "artifact",
        holding: { mediaType: "image/png" },
    },
    {
        name: "a download",
        step: {
            type: "download",
            name: "report",
            locator: { by: "role", role: "button", name: "Export" },
        },
        record: "download",
        holding: { downloadName: "report", sha256: sha256(FILE_BYTES) },
    },
    {
        name: "a remember",
        step: { type: "remember", name: "shownStatus", from: { element: STATUS, read: "text" } },
        record: "remembered",
        holding: { valueName: "shownStatus", sha256: sha256("Ready") },
    },
    {
        name: "an evaluate",
        step: READ_CART,
        record: "pageScript",
        holding: { script: "readCart", attempts: 1 },
    },
];

const START_STUB: JsonRecord = {
    type: "stub",
    stub: "loginNeedsCode",
    action: "start",
    arguments: { reason: "Enter the code" },
};
const expectText = (value: string): JsonRecord => ({
    type: "expect",
    locator: STATUS,
    assert: { kind: "textEquals", value },
    criterionId: "status.text-shown",
});

const stubLabelsOf = (records: readonly unknown[]): readonly unknown[] => records.flat();

describe("Using the run", () => {
    for (const { name: container, around } of CONTAINERS) {
        for (const { name, step, record, holding } of INNER_STEPS) {
            describe(`given ${name} inside ${container}`, () => {
                describe("when the step passes", () => {
                    test(`then it should keep its ${record} record in the result`, async () => {
                        const { result } = await runOnFakeSession(
                            unsafePlan([OPEN_CART, around([step])]),
                            {
                                session: sessionOfOneRun(),
                            },
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                        const records = recordsNamed(result.steps[1], record);
                        assert.ok(
                            isRecordHolding(records, holding),
                            JSON.stringify(result.steps[1]),
                        );
                    });
                });
            });
        }

        describe(`given two captures inside ${container}`, () => {
            describe("when both pass", () => {
                test("then it should keep both artifact records in the result", async () => {
                    const captures = [
                        { type: "capture", name: "first" },
                        { type: "capture", name: "second" },
                    ];
                    const { result } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, around(captures)]),
                        {
                            session: sessionOfOneRun(),
                        },
                    );
                    assert.equal(
                        recordsNamed(result.steps[1], "artifact").length,
                        2,
                        JSON.stringify(result.steps[1]),
                    );
                });
            });
        });

        describe(`given an expect inside ${container}`, () => {
            describe("and a stub started before it is active", () => {
                describe("when the check passes", () => {
                    test("then it should carry the stub's label", async () => {
                        const { result } = await runOnFakeSession(
                            unsafePlan([OPEN_CART, START_STUB, around([expectText("Ready")])]),
                            { session: sessionOfOneRun() },
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                        assert.deepEqual(
                            stubLabelsOf(recordsNamed(result.steps[2], "activeStubs")),
                            ["loginNeedsCode"],
                            JSON.stringify(result.steps[2]),
                        );
                    });
                });

                describe("when the check fails", () => {
                    test("then it should carry the stub's label", async () => {
                        const { result } = await runOnFakeSession(
                            unsafePlan([OPEN_CART, START_STUB, around([expectText("Not shown")])]),
                            { session: sessionOfOneRun() },
                        );
                        assert.equal(result.state, "Failed", JSON.stringify(result.steps));
                        assert.deepEqual(
                            stubLabelsOf(recordsNamed(result.steps[2], "activeStubs")),
                            ["loginNeedsCode"],
                            JSON.stringify(result.steps[2]),
                        );
                    });
                });
            });

            describe("and no stub is active", () => {
                describe("when the check passes", () => {
                    test("then it should carry no stub label", async () => {
                        const { result } = await runOnFakeSession(
                            unsafePlan([OPEN_CART, around([expectText("Ready")])]),
                            {
                                session: sessionOfOneRun(),
                            },
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                        assert.deepEqual(recordsNamed(result.steps[1], "activeStubs"), []);
                    });
                });
            });
        });

        describe(`given only a click inside ${container}`, () => {
            describe("and a stub is active", () => {
                describe("when the click passes", () => {
                    test("then it should carry no stub label, since nothing was checked", async () => {
                        const click: JsonRecord = {
                            type: "click",
                            locator: { by: "role", role: "button", name: "Pay" },
                        };
                        const { result } = await runOnFakeSession(
                            unsafePlan([OPEN_CART, START_STUB, around([click])]),
                            {
                                session: sessionOfOneRun(),
                            },
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                        assert.deepEqual(recordsNamed(result.steps[2], "activeStubs"), []);
                    });
                });
            });
        });
    }

    describe("given a capture and an a11yAudit at the top of the plan", () => {
        describe("when both pass", () => {
            test("then it should keep their records in the result", async () => {
                const { result } = await runOnFakeSession(
                    unsafePlan([
                        OPEN_CART,
                        { type: "capture", name: "top" },
                        { type: "a11yAudit", mode: "report" },
                    ]),
                    { session: sessionOfOneRun() },
                );
                assert.ok(result.steps[1]?.artifact !== undefined, JSON.stringify(result.steps));
                assert.deepEqual(result.steps[2]?.findings, [FINDING]);
            });
        });
    });

    describe("given an expect at the top of the plan", () => {
        describe("and a stub is active", () => {
            describe("when the check passes", () => {
                test("then it should carry the stub's label", async () => {
                    const { result } = await runOnFakeSession(
                        unsafePlan([OPEN_CART, START_STUB, expectText("Ready")]),
                        {
                            session: sessionOfOneRun(),
                        },
                    );
                    assert.deepEqual(result.steps[2]?.activeStubs, ["loginNeedsCode"]);
                });
            });
        });
    });
});
