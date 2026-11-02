// Shared by the tests of checks on pages the run cannot read.
import assert from "node:assert/strict";
import type { RunResult } from "@revisum/engine";

export function assertStepFailedWith(result: RunResult, index: number, code: string): void {
    const stepsBefore = result.steps.slice(0, index).map((step) => step.outcome);
    assert.ok(
        stepsBefore.every((outcome) => outcome === "passed"),
        `the plan reached the check: ${JSON.stringify(result.steps)}`,
    );
    assert.equal(result.state, "Failed", JSON.stringify(result.steps));
    assert.equal(result.steps[index]?.outcome, "failed", JSON.stringify(result.steps));
    assert.equal(result.steps[index]?.code, code, JSON.stringify(result.steps));
}
