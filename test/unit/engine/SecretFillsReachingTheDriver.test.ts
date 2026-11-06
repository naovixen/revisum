// A fill of a secret reaches the driver carrying the secret the run resolved for it, opaque: the
// driver needs nothing else to type it, and the action it is handed shows no value and no name left
// for it to look up.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { recordingDriver } from "./run-value-examples.ts";
import { runWithSecrets, secretFillPlan } from "./secret-examples.ts";

const SECRET_NAME = "ACCESS_CODE";
const SECRET_VALUE = "test-only-access-code";

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
                    fill?.type === "fill" &&
                        typeof fill.value === "object" &&
                        "secret" in fill.value,
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
});
