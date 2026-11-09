// A suite's criterion annotation is text from the report, and a credential can fit the shape of a
// criterion id. Every text the report holds goes through the redactor before it is kept, so one kept
// as a criterion id must not skip it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultRedactor, evidenceResult, parseSuiteReport } from "@revisum/engine";
import {
    evidenceContext,
    evidenceLimits,
    evidenceRun,
    recordedReport,
    reviewCodes,
    specPath,
    testsOf,
    tokenShapedText,
    type JsonRecord,
} from "../../evidence/examples/EvidenceRun.ts";
import { withValue } from "../../plan/examples/GoldenPlan.ts";

const ANNOTATIONS = [...specPath(0), "tests", 0, "annotations"];

// The recorded report with only this annotation on its first test, and its second test's malformed
// annotations left out, so the only review item it can raise is about this one.
const reportAnnotatedWith = (description: string): JsonRecord =>
    withValue(
        withValue(
            recordedReport("passing-with-criteria"),
            [...specPath(1), "tests", 0, "annotations"],
            [],
        ),
        ANNOTATIONS,
        [{ type: "criterion", description }],
    );

describe("Using an evidence result", () => {
    describe("given a criterion annotation shaped like a credential", () => {
        describe("when the result is built", () => {
            test("then it should not keep the credential", () => {
                const token = tokenShapedText();
                const result = evidenceRun(reportAnnotatedWith(token));
                assert.ok(
                    !JSON.stringify(result).includes(token),
                    "the result keeps the credential",
                );
            });
        });
    });

    describe("given a criterion annotation the run's redactor removes", () => {
        describe("when the result is built", () => {
            test("then it should not keep the annotation's text", () => {
                const secret = "shop-api-token-for-suite-runs-0042";
                const redactor = {
                    ...defaultRedactor(),
                    text: (raw: string) => raw.replaceAll(secret, "[redacted]"),
                };
                const report = reportAnnotatedWith(secret);
                const decoded = parseSuiteReport(report, evidenceLimits());
                assert.ok(decoded.ok, JSON.stringify(decoded));
                const result = evidenceResult(decoded.value, [], [], {
                    ...evidenceContext(report),
                    redactor,
                });
                assert.ok(!JSON.stringify(result).includes(secret), "the result keeps the secret");
            });
        });
    });

    describe("given an ordinary criterion annotation", () => {
        describe("when the result is built", () => {
            test("then it should keep it as the test's criterion, with nothing to review", () => {
                const result = evidenceRun(reportAnnotatedWith("checkout.total-shown"));
                const annotated = testsOf(result).filter((entry) =>
                    entry.criterionIds.some((id) => id === "checkout.total-shown"),
                );
                assert.equal(annotated.length, 1);
                assert.ok(!reviewCodes(result).includes("spec-ambiguous"));
            });
        });
    });
});
