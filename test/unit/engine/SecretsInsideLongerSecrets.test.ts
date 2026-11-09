// A secret can sit inside another, as a token sits inside the header value made from it. Redaction
// takes the longer one first: taking the shorter one first would split the longer value and leave
// the rest of it in the text.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    SECRET_PLACEHOLDER,
    defaultRedactor,
    environmentSecretStore,
    withDeclaredSecretRedaction,
    type Redactor,
    type SecretName,
} from "@revisum/engine";
import { secretName } from "./secret-examples.ts";

const INNER_NAME = secretName("INNER_TOKEN");
const OUTER_NAME = secretName("OUTER_TOKEN");
const INNER_VALUE = "innertokenvalue";
const OUTER_VALUE = `leadingpart-${INNER_VALUE}-trailingpart`;

// `names` is the order the secrets are declared in, so a shorter one can come first.
const redactorDeclaring = (names: readonly SecretName[]): Redactor =>
    withDeclaredSecretRedaction(
        defaultRedactor(),
        names,
        environmentSecretStore({ INNER_TOKEN: INNER_VALUE, OUTER_TOKEN: OUTER_VALUE }),
    );

describe("Using a redactor of declared secrets", () => {
    describe("given a secret that sits inside a longer secret", () => {
        for (const [order, names] of [
            ["shorter", [INNER_NAME, OUTER_NAME]],
            ["longer", [OUTER_NAME, INNER_NAME]],
        ] as const) {
            describe(`and the ${order} one declared first`, () => {
                describe("when a text holding the longer secret is redacted", () => {
                    test("then it should replace the whole of it", () => {
                        const redacted = redactorDeclaring(names).text(
                            `before ${OUTER_VALUE} after`,
                        );

                        assert.equal(redacted, `before ${SECRET_PLACEHOLDER} after`);
                    });
                });

                describe("when a text holding only the shorter secret is redacted", () => {
                    test("then it should replace that and keep the rest", () => {
                        const redacted = redactorDeclaring(names).text(
                            `before ${INNER_VALUE} after`,
                        );

                        assert.equal(redacted, `before ${SECRET_PLACEHOLDER} after`);
                    });
                });
            });
        }
    });
});
