// A search for a secret that throws has not shown a text is clean. Redaction then gives up the whole
// text, and the leak scanner reports a leak, rather than either passing what it could not read. A
// search reads text through the case folding, so that is where these tests make it throw.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, type TestContext } from "node:test";
import {
    SECRET_PLACEHOLDER,
    defaultRedactor,
    environmentSecretStore,
    leakScanner,
    withDeclaredSecretRedaction,
    type Leak,
    type Secret,
} from "@revisum/engine";
import { fakeSecretValue, resolvedSecret, secretName } from "./secret-examples.ts";

const NAME = "ACCOUNT_TOKEN";

function whileCaseFoldingThrows<Answer>(context: TestContext, action: () => Answer): Answer {
    const failing = context.mock.method(String.prototype, "toLowerCase", () => {
        throw new RangeError("the search could not run");
    });
    try {
        return action();
    } finally {
        failing.mock.restore();
    }
}

let folder: string;

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "secret-searches-"));
});

afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
});

function fileHolding(content: string): string {
    const path = join(folder, "kept.txt");
    writeFileSync(path, content);
    return path;
}

describe("Using a redactor of declared secrets", () => {
    describe("given a search for the secret that throws", () => {
        describe("when a text is redacted", () => {
            test("then it should give up the whole text", (context) => {
                const value = fakeSecretValue();
                const redactor = withDeclaredSecretRedaction(
                    defaultRedactor(),
                    [secretName(NAME)],
                    environmentSecretStore({ [NAME]: value }),
                );

                const redacted = whileCaseFoldingThrows(context, () =>
                    redactor.text(`Signed in with ${value}`),
                );

                assert.equal(redacted, SECRET_PLACEHOLDER);
            });
        });
    });

    describe("given a search for the secret that runs", () => {
        describe("when a text is redacted", () => {
            test("then it should remove only the secret", () => {
                const value = fakeSecretValue();
                const redactor = withDeclaredSecretRedaction(
                    defaultRedactor(),
                    [secretName(NAME)],
                    environmentSecretStore({ [NAME]: value }),
                );

                assert.equal(
                    redactor.text(`Signed in with ${value}`),
                    `Signed in with ${SECRET_PLACEHOLDER}`,
                );
            });
        });
    });
});

describe("Using the leak scanner", () => {
    describe("given a search for the secret that throws", () => {
        describe("when a file that does not hold the secret is scanned", () => {
            test("then it should report a raw leak", (context) => {
                const secret: Secret = resolvedSecret(NAME, fakeSecretValue());
                const path = fileHolding("nothing to see here");

                const leaks: readonly Leak[] = whileCaseFoldingThrows(context, () =>
                    leakScanner().scan([path], [secret]),
                );

                assert.deepEqual(leaks, [{ file: path, secret: secretName(NAME), form: "raw" }]);
            });
        });
    });

    describe("given a search for the secret that runs", () => {
        describe("when a file that does not hold the secret is scanned", () => {
            test("then it should report nothing", () => {
                const secret: Secret = resolvedSecret(NAME, fakeSecretValue());

                assert.deepEqual(
                    leakScanner().scan([fileHolding("nothing to see here")], [secret]),
                    [],
                );
            });
        });
    });
});
