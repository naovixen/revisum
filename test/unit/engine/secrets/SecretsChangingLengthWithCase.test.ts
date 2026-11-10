// Some characters change length with their case: "ß" upper-cases to "SS" and the "ﬁ" ligature to
// "FI". A page that upper-cases a value holding one writes a text longer than the value, and that
// text is still an echo of it. Everything here is planted and made up for the test.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
    SECRET_PLACEHOLDER,
    defaultRedactor,
    environmentSecretStore,
    leakScanner,
    withDeclaredSecretRedaction,
} from "@revisum/engine";
import { resolvedSecret, secretName } from "./examples/SecretRun.ts";

const NAME = "ACCOUNT_TOKEN";

const UPPER_CASED_ECHOES: readonly {
    readonly name: string;
    readonly value: string;
    readonly text: string;
}[] = [
    { name: 'starting with "ß"', value: "ßAbcd3fgh1jkl", text: "SSABCD3FGH1JKL" },
    { name: 'starting with the "ﬁ" ligature', value: "ﬁAbcd3fgh1jkl", text: "FIABCD3FGH1JKL" },
];

let folder: string;

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "secrets-changing-length-"));
});

afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
});

describe("Using the leak scanner", () => {
    for (const { name, value, text } of UPPER_CASED_ECHOES) {
        describe(`given a file holding the upper-cased form of a value ${name}`, () => {
            describe("when the file is scanned", () => {
                test("then it should report the leak", () => {
                    const path = join(folder, "kept.txt");
                    writeFileSync(path, `Signed in with ${text}`);

                    const leaks = leakScanner().scan([path], [resolvedSecret(NAME, value)]);

                    assert.ok(leaks.length > 0, `no leak reported in: ${text}`);
                });
            });
        });
    }
});

describe("Using a redactor of declared secrets", () => {
    for (const { name, value, text } of UPPER_CASED_ECHOES) {
        describe(`given a text holding the upper-cased form of a value ${name}`, () => {
            describe("when the text is redacted", () => {
                test("then it should remove the echo", () => {
                    const redactor = withDeclaredSecretRedaction(
                        defaultRedactor(),
                        [secretName(NAME)],
                        environmentSecretStore({ [NAME]: value }),
                    );

                    assert.equal(
                        redactor.text(`Signed in with ${text}`),
                        `Signed in with ${SECRET_PLACEHOLDER}`,
                    );
                });
            });
        });
    }
});
