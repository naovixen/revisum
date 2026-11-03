// A long secret is searched for in pieces, so a part of it cut from the middle may hold no whole piece,
// or leave ends sticking out past the pieces it holds. What a page shows of the secret is still the
// secret, so none of it may stay in the text. All values here are made up for the test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
    defaultRedactor,
    environmentSecretStore,
    withDeclaredSecretRedaction,
    type SecretName,
} from "@revisum/engine";
import { DATABASE_SECRET } from "./unsafe-feature-steps.ts";

const SECRET_LENGTH = 3_000;
// How long a part left behind must be to show, and to be unable to occur by chance in other text.
const SLICE_LENGTH = 16;

// No part of it repeats another, so finding one part of it says nothing about any other.
const secretOfLength = (length: number): string => {
    let value = "rv";
    for (let block = 0; value.length < length; block += 1) {
        value += createHash("sha256").update(String(block)).digest("base64");
    }
    return value.slice(0, length);
};

const SECRET = secretOfLength(SECRET_LENGTH);

const redact = (text: string): string =>
    withDeclaredSecretRedaction(
        defaultRedactor(),
        [DATABASE_SECRET as SecretName],
        environmentSecretStore({ [DATABASE_SECRET]: SECRET }),
    ).text(text);

const sliceSurvivingIn = (kept: string, written: string): string | undefined => {
    for (let start = 0; start + SLICE_LENGTH <= written.length; start += 1) {
        const slice = written.slice(start, start + SLICE_LENGTH);
        if (kept.includes(slice)) {
            return slice;
        }
    }
    return undefined;
};

const FRAGMENTS: readonly {
    readonly name: string;
    readonly start: number;
    readonly end: number;
}[] = [
    { name: "of 900 characters holding no whole piece", start: 550, end: 1450 },
    { name: "of 900 characters holding one whole piece", start: 300, end: 1200 },
    { name: "of 1,100 characters holding two whole pieces", start: 450, end: 1550 },
];

describe("Using secret redaction", () => {
    describe(`given a secret of ${SECRET_LENGTH} characters`, () => {
        for (const { name, start, end } of FRAGMENTS) {
            describe(`and text holding a part from its middle, ${name}`, () => {
                describe("when the text is redacted", () => {
                    test("then it should leave none of that part behind", () => {
                        const fragment = SECRET.slice(start, end);
                        const kept = redact(`before ${fragment} after`);
                        assert.equal(sliceSurvivingIn(kept, fragment), undefined);
                    });

                    test("then it should keep the text around it", () => {
                        const kept = redact(`before ${SECRET.slice(start, end)} after`);
                        assert.ok(kept.startsWith("before "), kept.slice(0, 40));
                        assert.ok(kept.endsWith(" after"), kept.slice(-40));
                    });
                });
            });
        }

        describe("and text holding none of it", () => {
            describe("when the text is redacted", () => {
                test("then it should give the text unchanged", () => {
                    assert.equal(redact("Nothing to hide"), "Nothing to hide");
                });
            });
        });
    });
});
