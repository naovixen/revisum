// A suite's report is parsed JSON. The first pass over it refuses whatever JSON cannot write before
// any field is read, wherever it sits, read by Revisum or not.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classInstanceHolding } from "../../../support/ClassInstanceHolding.ts";
import { decodeReport, recordedReport, specJsonPath, specPath } from "./examples/EvidenceRun.ts";
import { withValue } from "../plan/examples/GoldenPlan.ts";

const REPORT = "each-outcome";
const INVALID_AT_THE_TOP = [{ code: "suite-report-invalid", path: "$" }];

const errorsDecoding = (report: unknown): unknown => {
    const decoded = decodeReport(report);
    assert.ok(!decoded.ok, "the report was accepted");
    return decoded.error;
};

const reportWithFirstSpec = (spec: unknown): unknown =>
    withValue(recordedReport(REPORT), specPath(0), spec);

const firstSpec = (): object => {
    const spec = specPath(0).reduce<unknown>(
        (holder, segment) => Reflect.get(Object(holder), segment),
        recordedReport(REPORT),
    );
    assert.ok(typeof spec === "object" && spec !== null, "the report has no first spec");
    return spec;
};

const FIRST_SPEC_REFUSED = [{ code: "suite-report-invalid", path: specJsonPath(0) }];

describe("Using parseSuiteReport", () => {
    describe("given a report as JSON writes it", () => {
        describe("when it is decoded", () => {
            test("then it should accept it", () => {
                assert.equal(decodeReport(recordedReport(REPORT)).ok, true);
            });
        });
    });

    describe("given a Date as the report", () => {
        describe("when it is decoded", () => {
            test("then it should refuse it at the top", () => {
                assert.deepEqual(errorsDecoding(new Date(0)), INVALID_AT_THE_TOP);
            });
        });
    });

    describe("given a class instance holding exactly a report's fields", () => {
        describe("when it is decoded", () => {
            test("then it should refuse it at the top", () => {
                const report = classInstanceHolding(recordedReport(REPORT));
                assert.deepEqual(errorsDecoding(report), INVALID_AT_THE_TOP);
            });
        });
    });

    describe("given a Date in place of a spec", () => {
        describe("when it is decoded", () => {
            test("then it should refuse it at the spec", () => {
                assert.deepEqual(
                    errorsDecoding(reportWithFirstSpec(new Date(0))),
                    FIRST_SPEC_REFUSED,
                );
            });
        });
    });

    describe("given a class instance holding exactly a spec's fields", () => {
        describe("when it is decoded", () => {
            test("then it should refuse it at the spec", () => {
                assert.deepEqual(
                    errorsDecoding(reportWithFirstSpec(classInstanceHolding(firstSpec()))),
                    FIRST_SPEC_REFUSED,
                );
            });
        });
    });
});
