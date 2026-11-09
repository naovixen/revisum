// A browser started with flags of the caller's choosing, or a browser shared between runs, is for tests
// alone. So the driver package's production entry holds neither, and only its test-only entry does.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const PRODUCTION_ENTRY = "@revisum/driver-cdp";
const TEST_ONLY_ENTRY = "@revisum/driver-cdp/testing";
const TEST_ONLY_LAUNCHERS = ["launchSharedBrowser", "launchChromiumWithArguments"];

const exportsOf = async (entry: string): Promise<readonly string[]> =>
    Object.keys((await import(entry)) as object);

describe("Using the driver package's entry points", () => {
    describe("given the production entry", () => {
        describe("when its exports are read", () => {
            test("then it should hold no test-only launcher", async () => {
                const exported = await exportsOf(PRODUCTION_ENTRY);
                assert.deepEqual(
                    TEST_ONLY_LAUNCHERS.filter((launcher) => exported.includes(launcher)),
                    [],
                );
            });

            test("then it should keep the one isolated launcher the accessibility engine uses", async () => {
                assert.ok((await exportsOf(PRODUCTION_ENTRY)).includes("launchChromium"));
            });
        });
    });

    describe("given the test-only entry", () => {
        describe("when its exports are read", () => {
            test("then it should hold the test-only launchers", async () => {
                const exported = await exportsOf(TEST_ONLY_ENTRY);
                assert.deepEqual(
                    TEST_ONLY_LAUNCHERS.filter((launcher) => !exported.includes(launcher)),
                    [],
                );
            });
        });
    });
});
