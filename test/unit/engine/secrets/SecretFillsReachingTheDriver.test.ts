// A fill of a secret reaches the driver carrying the secret the run resolved for it, opaque: the
// driver needs nothing else to type it, and the action it is handed shows no value and no name left
// for it to look up.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FillValueKind } from "@revisum/engine";
import { recordingDriver } from "../run/values/examples/RunPlan.ts";
import { runWithSecrets, secretFillPlan } from "./examples/SecretRun.ts";

const SECRET_NAME = "ACCESS_CODE";
const SECRET_VALUE = "test-only-access-code";
const SECOND_SECRET_NAME = "ACCOUNT_PIN";
const THIRD_SECRET_NAME = "RECOVERY_WORD";

describe("Using the run", () => {
    describe("given a plan that fills a field with a secret the store holds", () => {
        describe("when the run reaches the fill", () => {
            test("then it should hand the driver a fill carrying that secret, and pass", async () => {
                const { driver, recording } = recordingDriver();
                const { result } = await runWithSecrets(
                    [SECRET_NAME],
                    secretFillPlan([SECRET_NAME]),
                    { [SECRET_NAME]: SECRET_VALUE },
                    driver,
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                const fills = recording.actions.filter((action) => action.type === "fill");
                assert.equal(fills.length, 1);
                const [fill] = fills;
                assert.ok(
                    fill?.type === "fill" && fill.value.kind === FillValueKind.Secret,
                    JSON.stringify(fill),
                );
                assert.equal(fill.value.secret.name, SECRET_NAME);
                assert.equal(JSON.stringify(fill.value.secret), JSON.stringify("[secret]"));
            });

            test("then it should hand the driver no secret value and no secret name to look up", async () => {
                const { driver, recording } = recordingDriver();
                await runWithSecrets(
                    [SECRET_NAME],
                    secretFillPlan([SECRET_NAME]),
                    { [SECRET_NAME]: SECRET_VALUE },
                    driver,
                );
                const handed = JSON.stringify(recording.actions);
                assert.equal(handed.includes(SECRET_VALUE), false, handed);
                assert.equal(handed.includes("secretName"), false, handed);
            });
        });
    });

    describe("given a plan that fills several fields, each with another secret the store holds", () => {
        describe("when the run passes preflight and reaches the fills", () => {
            test("then it should hand the driver every fill carrying its own secret, and pass", async () => {
                const names = [SECRET_NAME, SECOND_SECRET_NAME, THIRD_SECRET_NAME];
                const { driver, recording } = recordingDriver();
                const { result } = await runWithSecrets(
                    names,
                    secretFillPlan(names),
                    {
                        [SECRET_NAME]: SECRET_VALUE,
                        [SECOND_SECRET_NAME]: "test-only-account-pin",
                        [THIRD_SECRET_NAME]: "test-only-recovery-word",
                    },
                    driver,
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                const filledSecrets = recording.actions.flatMap((action) =>
                    action.type === "fill" && action.value.kind === FillValueKind.Secret
                        ? [action.value.secret.name]
                        : [],
                );
                assert.deepEqual(filledSecrets, names);
            });
        });
    });
});
