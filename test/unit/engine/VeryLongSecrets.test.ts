// A secret can be long: a saved token, a certificate. Past about 5,180 characters the patterns built to
// find its echoes grow beyond what the regular expression engine accepts. That must cost nothing: the
// run still ends with its verdict, and an echo of the secret is still gone from what the run keeps.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
    defaultRedactor,
    environmentSecretStore,
    leakScanner,
    withDeclaredSecretRedaction,
    type ElementProbe,
    type SecretName,
} from "@revisum/engine";
import { fakeSession, runOnFakeSession } from "./RunOnFakeSession.ts";
import { resolvedSecret } from "./secret-examples.ts";
import { DATABASE_SECRET, OPEN_CART, unsafePlan, type JsonRecord } from "./unsafe-feature-steps.ts";

const LENGTHS: readonly number[] = [5_200, 20_000];

// Varied enough that no piece of it is another's repeat, and with the symbols secrets hold: each
// takes more of a pattern than a letter does.
const secretOfLength = (length: number): string => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789/+=~?";
    const characters = [...Array(length).keys()].map(
        (index) => alphabet[(index * index + index) % alphabet.length],
    );
    return `rv${characters.join("")}`.slice(0, length);
};

const FILL_SECRET: JsonRecord = {
    type: "fill",
    locator: { by: "label", label: "Access code" },
    value: { secretName: DATABASE_SECRET },
};
const FAILING_CHECK: JsonRecord = {
    type: "expect",
    locator: { by: "testId", testId: "status" },
    assert: { kind: "textEquals", value: "Signed in" },
    criterionId: "status.signed-in",
};

const showing = (text: string): ElementProbe => ({
    count: 1,
    visible: true,
    enabled: true,
    text,
    value: null,
    sensitive: false,
    box: null,
});

const runShowing = (value: string, shown: string) =>
    runOnFakeSession(unsafePlan([OPEN_CART, FILL_SECRET, FAILING_CHECK]), {
        session: fakeSession({ probe: () => Promise.resolve(showing(shown)) }),
        secrets: environmentSecretStore({ [DATABASE_SECRET]: value }),
    });

let folder: string;
before(() => {
    folder = mkdtempSync(join(tmpdir(), "very-long-secrets-"));
});
after(() => {
    rmSync(folder, { recursive: true, force: true });
});

const redactorHolding = (value: string) =>
    withDeclaredSecretRedaction(
        defaultRedactor(),
        [DATABASE_SECRET as SecretName],
        environmentSecretStore({ [DATABASE_SECRET]: value }),
    );

describe("Using secret redaction", () => {
    for (const length of LENGTHS) {
        describe(`given a secret of ${length} characters`, () => {
            describe("when text without it is redacted", () => {
                test("then it should give the text unchanged", () => {
                    const redactor = redactorHolding(secretOfLength(length));
                    assert.equal(redactor.text("Nothing to hide"), "Nothing to hide");
                });
            });

            describe("when text holding it is redacted", () => {
                test("then it should remove the secret and keep the rest", () => {
                    const value = secretOfLength(length);
                    const redacted = redactorHolding(value).text(`before ${value} after`);
                    assert.equal(redacted.includes(value), false);
                    assert.ok(redacted.startsWith("before "), redacted.slice(0, 40));
                    assert.ok(redacted.endsWith(" after"), redacted.slice(-40));
                });
            });

            describe("when a run shows it on a check that fails", () => {
                test("then it should end with the verdict", async () => {
                    const value = secretOfLength(length);
                    const { result } = await runShowing(value, `token ${value}`);
                    assert.equal(result.state, "Failed", JSON.stringify(result.state));
                    assert.equal(result.steps[2]?.code, "assertion-failed");
                });

                test("then it should keep none of it in the result or the log", async () => {
                    const value = secretOfLength(length);
                    const { result, events } = await runShowing(value, `token ${value}`);
                    const kept = JSON.stringify(result) + JSON.stringify(events.read());
                    assert.equal(kept.includes(value.slice(0, 40)), false);
                });
            });

            describe("when a file holding it is scanned", () => {
                test("then it should report the leak", () => {
                    const value = secretOfLength(length);
                    const path = join(folder, `holding-${length}.txt`);
                    writeFileSync(path, `token=${value}\n`);
                    const leaks = leakScanner().scan([path], [resolvedSecret("LONG_TOKEN", value)]);
                    assert.ok(
                        leaks.some((leak) => leak.form === "raw"),
                        JSON.stringify(leaks),
                    );
                });
            });

            describe("when a file without it is scanned", () => {
                test("then it should report nothing", () => {
                    const path = join(folder, `clean-${length}.txt`);
                    writeFileSync(path, "Nothing to hide\n");
                    const leaks = leakScanner().scan(
                        [path],
                        [resolvedSecret("LONG_TOKEN", secretOfLength(length))],
                    );
                    assert.deepEqual(leaks, []);
                });
            });
        });
    }

    describe("given a secret just short of the length where patterns grow too large", () => {
        describe("when a run shows it on a check that fails", () => {
            test("then it should keep none of it", async () => {
                const value = secretOfLength(5_000);
                const { result, events } = await runShowing(value, `token ${value}`);
                assert.equal(result.state, "Failed");
                const kept = JSON.stringify(result) + JSON.stringify(events.read());
                assert.equal(kept.includes(value.slice(0, 40)), false);
            });
        });
    });
});
