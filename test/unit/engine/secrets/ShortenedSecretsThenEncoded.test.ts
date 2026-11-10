// A log line can cut a token short and then encode what is left. The start of a value is an echo of
// it however it is written, so a shortened value must be found once encoded as well as plain.
// Everything here is planted and made up for the test.
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
const VALUE = "Ab/d3f+h1jk=mnop";
const FIRST_TWELVE_CHARACTERS = VALUE.slice(0, 12);

const ENCODED_PREFIXES: readonly { readonly name: string; readonly written: string }[] = [
    { name: "URI-encoded", written: encodeURIComponent(FIRST_TWELVE_CHARACTERS) },
    {
        name: "in base64",
        written: Buffer.from(FIRST_TWELVE_CHARACTERS, "utf8").toString("base64"),
    },
];

let folder: string;

beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "shortened-secrets-"));
});

afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
});

describe("Using the leak scanner", () => {
    for (const { name, written } of ENCODED_PREFIXES) {
        describe(`given a file holding the first twelve characters of a value, ${name}`, () => {
            describe("when the file is scanned", () => {
                test("then it should report the leak", () => {
                    const path = join(folder, "kept.txt");
                    writeFileSync(path, `Signed in with ${written}`);

                    const leaks = leakScanner().scan([path], [resolvedSecret(NAME, VALUE)]);

                    assert.ok(leaks.length > 0, `no leak reported in: ${written}`);
                });
            });
        });
    }
});

describe("Using a redactor of declared secrets", () => {
    for (const { name, written } of ENCODED_PREFIXES) {
        describe(`given a text holding the first twelve characters of a value, ${name}`, () => {
            describe("when the text is redacted", () => {
                test("then it should remove the echo", () => {
                    const redactor = withDeclaredSecretRedaction(
                        defaultRedactor(),
                        [secretName(NAME)],
                        environmentSecretStore({ [NAME]: VALUE }),
                    );

                    assert.equal(
                        redactor.text(`Signed in with ${written}`),
                        `Signed in with ${SECRET_PLACEHOLDER}`,
                    );
                });
            });
        });
    }
});
