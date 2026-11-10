// A plan run's manifest says which target, adapter and browser it ran on; an evidence run's says
// none of them, since its suite brings its own browser. A manifest read back for a replay must be one
// or the other, so one that lacks a plan field, or mixes the two kinds, is refused at that field.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeManifest } from "@revisum/engine";
import { suiteRunManifest } from "../evidence/examples/EvidenceRun.ts";
import { quietDriver, runWithSecrets, secretFillPlan } from "../secrets/examples/SecretRun.ts";

const PLAN_RUN_ONLY_FIELDS = ["target", "adapter", "browser"] as const;

const jsonOf = (value: unknown): Readonly<Record<string, unknown>> => {
    const copy: unknown = JSON.parse(JSON.stringify(value));
    assert.ok(typeof copy === "object" && copy !== null && !Array.isArray(copy));
    return Object.fromEntries(Object.entries(copy));
};

const planRunManifest = async (): Promise<Readonly<Record<string, unknown>>> => {
    const { result } = await runWithSecrets([], secretFillPlan([]), {}, quietDriver());
    assert.ok(result.manifest !== null, "the plan run made no manifest");
    return jsonOf(result.manifest);
};

const without = (
    manifest: Readonly<Record<string, unknown>>,
    field: string,
): Readonly<Record<string, unknown>> =>
    Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== field));

describe("Using the manifest decoder", () => {
    describe("given the manifest a plan run wrote", () => {
        describe("when it is decoded", () => {
            test("then it should read back exactly as written", async () => {
                const manifest = await planRunManifest();
                assert.deepEqual(decodeManifest(manifest), { ok: true, value: manifest });
            });
        });

        for (const field of PLAN_RUN_ONLY_FIELDS) {
            describe(`and its ${field} removed`, () => {
                describe("when it is decoded", () => {
                    test(`then it should refuse it as replay-mismatch at $.${field}`, async () => {
                        const manifest = without(await planRunManifest(), field);
                        assert.deepEqual(decodeManifest(manifest), {
                            ok: false,
                            error: { code: "replay-mismatch", path: `$.${field}` },
                        });
                    });
                });
            });
        }
    });

    describe("given the manifest an evidence run wrote", () => {
        describe("when it is decoded", () => {
            test("then it should read back exactly as written", () => {
                const manifest = jsonOf(suiteRunManifest());
                assert.deepEqual(decodeManifest(manifest), { ok: true, value: manifest });
            });
        });

        for (const field of PLAN_RUN_ONLY_FIELDS) {
            describe(`and a plan run's ${field} added`, () => {
                describe("when it is decoded", () => {
                    test(`then it should refuse it as replay-mismatch at $.${field}`, async () => {
                        const planManifest = await planRunManifest();
                        const mixed = {
                            ...jsonOf(suiteRunManifest()),
                            [field]: planManifest[field],
                        };
                        assert.deepEqual(decodeManifest(mixed), {
                            ok: false,
                            error: { code: "replay-mismatch", path: `$.${field}` },
                        });
                    });
                });
            });
        }
    });
});
