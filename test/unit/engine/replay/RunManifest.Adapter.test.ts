// What the run manifest pins of the driver a run used: its id, version and protocol, and the inputs
// it cannot pin.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeManifest, type BrowserDriver, type RunResult } from "@revisum/engine";
import { quietDriver, runWithSecrets, secretFillPlan } from "../secrets/examples/SecretRun.ts";

const driverWith = (info: Partial<BrowserDriver["info"]>): BrowserDriver => {
    const driver = quietDriver();
    return { ...driver, info: { ...driver.info, ...info } };
};

const resultOn = async (driver: BrowserDriver): Promise<RunResult> =>
    (await runWithSecrets([], secretFillPlan([]), {}, driver)).result;

describe("Using the run manifest", () => {
    describe("given a driver", () => {
        describe("when a run records its adapter", () => {
            test("then it should keep the id, version and protocol", async () => {
                const result = await resultOn(driverWith({}));
                assert.deepEqual(result.manifest?.adapter, {
                    id: "fake",
                    version: "1.0",
                    protocol: "none",
                });
            });
        });
    });

    describe("given a driver of another version", () => {
        describe("when a run records its adapter", () => {
            test("then it should give another manifest hash", async () => {
                const first = await resultOn(driverWith({ version: "1.0" }));
                const second = await resultOn(driverWith({ version: "1.1" }));
                assert.notEqual(second.manifestHash, first.manifestHash);
            });
        });
    });

    describe("given a driver that cannot pin an input", () => {
        describe("when a run records its adapter", () => {
            test("then it should keep what it cannot pin", async () => {
                const result = await resultOn(driverWith({ cannotPin: ["randomness"] }));
                assert.deepEqual(result.manifest?.adapter?.cannotPin, ["randomness"]);
            });
        });
    });

    describe("given the manifest a run wrote", () => {
        describe("when it is decoded", () => {
            test("then it should read back exactly as written", async () => {
                const { manifest } = await resultOn(driverWith({}));
                assert.deepEqual(decodeManifest(JSON.parse(JSON.stringify(manifest))), {
                    ok: true,
                    value: manifest,
                });
            });
        });
    });

    describe("given a manifest that records the adapter's features", () => {
        describe("when it is decoded", () => {
            test("then it should refuse the field as another version's", async () => {
                const { manifest } = await resultOn(driverWith({}));
                const withFeatures = {
                    ...manifest,
                    adapter: {
                        id: "fake",
                        version: "1.0",
                        protocol: "none",
                        performs: ["positions", "keyChords", "downloads"],
                    },
                };
                assert.deepEqual(decodeManifest(withFeatures), {
                    ok: false,
                    error: { code: "version-unsupported", path: "$.adapter.performs" },
                });
            });
        });
    });
});
