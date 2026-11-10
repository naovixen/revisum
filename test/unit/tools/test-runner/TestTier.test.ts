// Which tests a run covers comes from one environment variable, so a wrong value must never pass
// quietly as a lighter run.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import {
    TestTier,
    currentTestTier,
    determinismRuns,
    fullTierOnly,
    onTarget,
} from "#test-support/TestTier.ts";

const VARIABLE = "REVISUM_TEST_TIER";

describe("Using the test tier", () => {
    let tierBefore: string | undefined;

    beforeEach(() => {
        tierBefore = process.env[VARIABLE];
    });
    afterEach(() => {
        if (tierBefore === undefined) {
            delete process.env[VARIABLE];
        } else {
            process.env[VARIABLE] = tierBefore;
        }
    });

    describe("given no tier is set", () => {
        beforeEach(() => {
            delete process.env[VARIABLE];
        });

        describe("when a test reads the tier", () => {
            test("then it should be the push tier, with two determinism runs", () => {
                assert.equal(currentTestTier(), TestTier.Push);
                assert.equal(determinismRuns(), 2);
            });

            test("then it should skip a full-only test and say why", () => {
                assert.match(
                    fullTierOnly("the reason").skip ?? "",
                    /REVISUM_TEST_TIER=full.*the reason/,
                );
            });

            test("then it should skip the headless shell and keep Chrome for Testing", () => {
                assert.match(onTarget(BrowserTarget.HeadlessShell).skip ?? "", /headless shell/);
                assert.deepEqual(onTarget(BrowserTarget.Chrome), {});
            });
        });
    });

    describe("given the full tier is set", () => {
        beforeEach(() => {
            process.env[VARIABLE] = TestTier.Full;
        });

        describe("when a test reads the tier", () => {
            test("then it should be the full tier, with twenty determinism runs", () => {
                assert.equal(currentTestTier(), TestTier.Full);
                assert.equal(determinismRuns(), 20);
            });

            test("then it should skip nothing", () => {
                assert.deepEqual(fullTierOnly("the reason"), {});
                assert.deepEqual(onTarget(BrowserTarget.HeadlessShell), {});
            });
        });
    });

    describe("given a tier that does not exist", () => {
        beforeEach(() => {
            process.env[VARIABLE] = "ful";
        });

        describe("when a test reads the tier", () => {
            test("then it should throw, naming the value and the tiers there are", () => {
                assert.throws(() => currentTestTier(), /"ful"; use one of push, full/);
            });
        });
    });
});
