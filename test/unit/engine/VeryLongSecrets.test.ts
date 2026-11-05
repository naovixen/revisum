// A secret can be long: a saved token, a certificate. Past about 5,180 characters the patterns built to
// find its echoes grow beyond what the regular expression engine accepts. That must cost nothing: the
// run still ends with its verdict, and an echo of the secret is still gone from what the run keeps.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { REPOSITORY_ROOT } from "../../support/repository.ts";
import { fakeSessionOnOrders, runOnFakeSession } from "./RunOnFakeSession.ts";
import { resolvedSecret } from "./secret-examples.ts";
import { DATABASE_SECRET, OPEN_CART, unsafePlan, type JsonRecord } from "./unsafe-feature-steps.ts";
import { FAKE_ELEMENT } from "#test-support/fakes/FakePage.ts";

const LENGTHS: readonly number[] = [5_200, 20_000];

// No piece of it repeats another, so finding one part of it says nothing about any other, and it has
// the symbols secrets hold: each takes more of a pattern than a letter does.
const secretOfLength = (length: number): string => {
    let value = "rv";
    for (let block = 0; value.length < length; block += 1) {
        value += createHash("sha256")
            .update(String(block))
            .digest("base64")
            .replaceAll("A", "~")
            .replaceAll("B", "?");
    }
    return value.slice(0, length);
};

// Short enough that a part left behind shows, long enough that it cannot occur by chance in what
// else a result holds, such as its hashes.
const SLICE_LENGTH = 16;

// The first slice of `written` still in `kept`, in any case, or undefined when none is.
const sliceSurvivingIn = (kept: string, written: string): string | undefined => {
    const foldedKept = kept.toLowerCase();
    const foldedWritten = written.toLowerCase();
    for (let start = 0; start + SLICE_LENGTH <= foldedWritten.length; start += 1) {
        const slice = foldedWritten.slice(start, start + SLICE_LENGTH);
        if (foldedKept.includes(slice)) {
            return slice;
        }
    }
    return undefined;
};

const ECHOES: readonly { readonly name: string; readonly written: (value: string) => string }[] = [
    { name: "base64", written: (value) => Buffer.from(value).toString("base64") },
    { name: "base64url", written: (value) => Buffer.from(value).toString("base64url") },
    {
        name: "base64 after a user name",
        written: (value) => Buffer.from(`user:${value}`).toString("base64"),
    },
    {
        name: "a JSON string with its slashes escaped",
        written: (value) => JSON.stringify(value).slice(1, -1).replaceAll("/", "\\/"),
    },
    { name: "a URL", written: (value) => encodeURIComponent(value) },
    {
        name: "form encoding",
        written: (value) => new URLSearchParams({ token: value }).toString().slice("token=".length),
    },
];

const BACKSLASH_RUN_LENGTH = 20_000;
const LONGEST_BACKSLASH_RUN_MILLISECONDS = 60_000;

// In a process of its own, because a pattern that hangs holds its thread and no test's timeout could
// end it. It prints what it was given back, so an answer proves the work was done.
const BACKSLASH_RUN_SCRIPT = `
  import { defaultRedactor, environmentSecretStore, withDeclaredSecretRedaction,
} from "@revisum/engine";
  const run = "\\\\".repeat(${BACKSLASH_RUN_LENGTH});
  const value = "z" + run + "q";
  const redactor = withDeclaredSecretRedaction(defaultRedactor(), ["${DATABASE_SECRET}"], environmentSecretStore({ "${DATABASE_SECRET}": value }));
  console.log(JSON.stringify({
    withoutIt: redactor.text("Nothing to hide"),
    nearly: redactor.text("before " + run.slice(1) + " after"),
    holdingIt: redactor.text("before " + value + " after"),
  }));
`;

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

const showing = (text: string): ElementProbe => ({ ...FAKE_ELEMENT, text });

const runShowing = (value: string, shown: string) =>
    runOnFakeSession(unsafePlan([OPEN_CART, FILL_SECRET, FAILING_CHECK]), {
        session: fakeSessionOnOrders({ probe: () => Promise.resolve(showing(shown)) }),
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
                    assert.equal(sliceSurvivingIn(kept, value), undefined);
                });
            });

            for (const { name, written } of ECHOES) {
                describe(`when text holding it as ${name} is redacted`, () => {
                    test("then it should keep no slice of it and keep the rest", () => {
                        const echo = written(secretOfLength(length));
                        const redacted = redactorHolding(secretOfLength(length)).text(
                            `before ${echo} after`,
                        );
                        assert.equal(sliceSurvivingIn(redacted, echo), undefined);
                        assert.ok(redacted.startsWith("before "), redacted.slice(0, 40));
                        assert.ok(redacted.endsWith(" after"), redacted.slice(-40));
                    });
                });

                describe(`when a run shows it as ${name} on a check that fails`, () => {
                    test("then it should keep no slice of it in the result or the log", async () => {
                        const value = secretOfLength(length);
                        const echo = written(value);
                        const { result, events } = await runShowing(value, `token ${echo}`);
                        const kept = JSON.stringify(result) + JSON.stringify(events.read());
                        assert.equal(sliceSurvivingIn(kept, echo), undefined);
                        assert.equal(
                            result.steps[2]?.observed?.startsWith("token "),
                            true,
                            "the run kept no observation to look in",
                        );
                    });
                });
            }

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
                assert.equal(sliceSurvivingIn(kept, value), undefined);
            });
        });
    });

    describe("given a secret that is a very long run of backslashes", () => {
        describe("when text without it, with nearly all of it, and holding it are redacted", () => {
            test("then it should finish, keep the first and remove the secret from the others", () => {
                const finished = spawnSync(
                    process.execPath,
                    ["--input-type=module", "--eval", BACKSLASH_RUN_SCRIPT],
                    {
                        cwd: REPOSITORY_ROOT,
                        encoding: "utf8",
                        timeout: LONGEST_BACKSLASH_RUN_MILLISECONDS,
                        windowsHide: true,
                    },
                );
                assert.equal(finished.error, undefined, "the redaction did not finish in time");
                assert.equal(finished.status, 0, finished.stderr);
                assert.deepEqual(JSON.parse(finished.stdout), {
                    withoutIt: "Nothing to hide",
                    nearly: "before [redacted:secret] after",
                    holdingIt: "before [redacted:secret] after",
                });
            });
        });
    });
});
