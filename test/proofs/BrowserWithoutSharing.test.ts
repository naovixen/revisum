// A file that does not ask to share a browser runs as production does: a browser per session.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import {
    capabilityHarness,
    ownDriverFor,
    type CapabilityHarness,
} from "#test-support/capability-harness.ts";
import { isRunning } from "#test-support/process-tree.ts";

describe("Using a browser driver with no browser source", () => {
    let harness: CapabilityHarness;

    before(async () => {
        harness = await capabilityHarness();
    });
    after(async () => {
        await harness.close();
    });

    describe("given a session it has opened", () => {
        describe("when another session opens and the first closes", () => {
            test("then it should have launched a browser for each and stopped the first", async () => {
                const driver = ownDriverFor(BrowserTarget.Chrome);
                const target = harness.target(BrowserTarget.Chrome);
                const first = await driver.open(target, harness.environment());
                const second = await driver.open(target, harness.environment());
                assert.ok(first.ok, JSON.stringify(first));
                assert.ok(second.ok, JSON.stringify(second));
                const firstProcess = first.value.processId;
                const secondProcess = second.value.processId;
                try {
                    assert.notEqual(firstProcess, secondProcess);
                    assert.ok(isRunning(firstProcess));
                    await first.value.close();
                    assert.equal(isRunning(firstProcess), false);
                    assert.ok(isRunning(secondProcess));
                } finally {
                    await second.value.close();
                }
                assert.equal(isRunning(secondProcess), false);
            });
        });
    });
});
