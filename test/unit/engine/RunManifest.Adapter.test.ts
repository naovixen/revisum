// What the run manifest pins of the driver a run used: its id, version and protocol, and the inputs
// it cannot pin. The features it performs are not an input of their own: a run's steps show what
// they needed, so adding a feature to a driver leaves other plans' hashes as they were.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    decodeManifest,
    type BrowserDriver,
    type DriverFeature,
    type RunResult,
} from "@revisum/engine";
import { quietDriver, runWithSecrets, secretFillPlan } from "./secret-examples.ts";

const driverWith = (info: Partial<BrowserDriver["info"]>): BrowserDriver => {
    const driver = quietDriver();
    return { ...driver, info: { ...driver.info, ...info } };
};

const resultOn = async (driver: BrowserDriver): Promise<RunResult> =>
    (await runWithSecrets([], secretFillPlan([]), {}, driver)).result;

const FEW_FEATURES: readonly DriverFeature[] = ["positions"];
const MORE_FEATURES: readonly DriverFeature[] = ["positions", "keyChords", "downloads"];

describe("Using the run manifest", () => {
    describe("given a driver that declares the features it performs", () => {
        describe("when a run records its adapter", () => {
            test("then it should keep the id, version and protocol and leave the features out", async () => {
                const result = await resultOn(driverWith({ performs: MORE_FEATURES }));
                assert.deepEqual(result.manifest?.adapter, {
                    id: "fake",
                    version: "1.0",
                    protocol: "none",
                });
            });
        });

        describe("when another run's driver declares other features the plan does not use", () => {
            test("then it should give the same manifest hash and result hash", async () => {
                const few = await resultOn(driverWith({ performs: FEW_FEATURES }));
                const more = await resultOn(driverWith({ performs: MORE_FEATURES }));
                assert.equal(few.state, "Passed", JSON.stringify(few.steps));
                assert.equal(more.manifestHash, few.manifestHash);
                assert.equal(more.resultHash, few.resultHash);
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
                const { manifest } = await resultOn(driverWith({ performs: MORE_FEATURES }));
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
                        performs: MORE_FEATURES,
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
