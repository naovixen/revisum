// A page chooses the text a run keeps, so a page can hand redaction the input it finds hardest. Time
// spent must stay in step with the length of that text, and the work must still be done on it.
//
// The timing tests compare the same work at two lengths rather than against a clock, so a slow machine
// slows both alike. Four times the text takes about four times as long when the work is linear and
// about sixteen times when it is quadratic.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Redactor } from "@revisum/contracts";
import {
    SECRET_PLACEHOLDER,
    defaultRedactor,
    environmentSecretStore,
    withDeclaredSecretRedaction,
} from "@revisum/engine";
import { secretName } from "./examples/SecretRun.ts";

const LENGTH_FACTOR = 4;
const MOST_GROWTH_ALLOWED = 8;

// Work this quick is lost in timer resolution and garbage collection, where a ratio means nothing.
const MILLISECONDS_OF_NOISE = 25;

const ROUNDS = 3;

const LETTER_RUN_LENGTH = 10_000;
const WHITE_SPACE_RUN_LENGTH = 2_500;

type Timings = { readonly shorter: number; readonly longer: number };

const millisecondsToRun = (work: () => void): number => {
    const started = performance.now();
    work();
    return performance.now() - started;
};

// The quickest of several rounds, alternating the lengths, so that a pause or a burst of other work
// on the machine lands on neither length alone and compiling the pattern counts against neither.
function quickestTimings(
    redact: (text: string) => string,
    textAt: (length: number) => string,
    length: number,
): Timings {
    const shorterText = textAt(length);
    const longerText = textAt(length * LENGTH_FACTOR);
    let shorter = Number.POSITIVE_INFINITY;
    let longer = Number.POSITIVE_INFINITY;
    for (let round = 0; round < ROUNDS; round += 1) {
        shorter = Math.min(
            shorter,
            millisecondsToRun(() => redact(shorterText)),
        );
        longer = Math.min(
            longer,
            millisecondsToRun(() => redact(longerText)),
        );
    }
    return { shorter, longer };
}

const assertTimeGrowsInStepWithLength = ({ shorter, longer }: Timings): void => {
    assert.ok(
        longer <= shorter * MOST_GROWTH_ALLOWED + MILLISECONDS_OF_NOISE,
        `${LENGTH_FACTOR} times the text took ${(longer / shorter).toFixed(1)} times as long: ${shorter.toFixed(1)} ms, then ${longer.toFixed(1)} ms`,
    );
};

const letters = (length: number): string => "A".repeat(length);

const TOKEN_NAME = "ACCOUNT_TOKEN";
const TOKEN = "tok_Zq7w-live-9xPm";
const LETTER_RUN_AROUND_MATCHES = letters(LETTER_RUN_LENGTH * LENGTH_FACTOR);

// Its symbols are ones an encoder rewrites, so an encoded echo can only be found through its writings.
const SPACED_NAME = "SPACED_PASSWORD";
const SPACED_WORDS = "Tr0ub/4dor&and=three";
const SPACED_VALUE = ` ${SPACED_WORDS}`;

const WHITE_SPACE_RUNS: readonly { readonly name: string; readonly unit: string }[] = [
    { name: "spaces", unit: " " },
    { name: "URL-encoded spaces", unit: "%20" },
];

const declaring = (base: Redactor, name: string, value: string): Redactor =>
    withDeclaredSecretRedaction(
        base,
        [secretName(name)],
        environmentSecretStore({ [name]: value }),
    );

const redactingSpacedPassword = (): Redactor =>
    declaring(defaultRedactor(), SPACED_NAME, SPACED_VALUE);

// Leaves the search for the secret as the only work timed: a run of "%20" is also hard on the email
// pattern, which has a test of its own.
const REDACTOR_OF_NOTHING: Redactor = { selectors: [], text: (value) => value };

describe("Using the default redactor", () => {
    describe("given a long run of letters holding nothing to redact", () => {
        describe("when a text four times as long is redacted", () => {
            test("then it should take about four times as long", () => {
                assertTimeGrowsInStepWithLength(
                    quickestTimings(
                        (text) => defaultRedactor().text(text),
                        letters,
                        LETTER_RUN_LENGTH,
                    ),
                );
            });
        });

        describe("when it is redacted", () => {
            test("then it should give the text unchanged", () => {
                assert.equal(
                    defaultRedactor().text(LETTER_RUN_AROUND_MATCHES),
                    LETTER_RUN_AROUND_MATCHES,
                );
            });
        });
    });

    describe("given an email address whose name is a long run of letters", () => {
        describe("when it is redacted", () => {
            test("then it should remove the whole address", () => {
                assert.equal(
                    defaultRedactor().text(`${LETTER_RUN_AROUND_MATCHES}@example.com`),
                    "[redacted:email]",
                );
            });
        });
    });

    for (const { kind, written } of [
        { kind: "email", written: "person@example.com" },
        { kind: "card", written: "4111 1111 1111 1111" },
        { kind: "phone", written: "+44 20 7946 0958" },
    ]) {
        describe(`given a ${kind} value between long runs of letters`, () => {
            describe("when it is redacted", () => {
                test("then it should replace the value and keep the runs", () => {
                    const run = LETTER_RUN_AROUND_MATCHES;
                    assert.equal(
                        defaultRedactor().text(`${run} ${written}, ${run}`),
                        `${run} [redacted:${kind}], ${run}`,
                    );
                });
            });
        });
    }
});

describe("Using a redactor of declared secrets", () => {
    describe("given a secret inside a long run of letters", () => {
        describe("when it is redacted", () => {
            test("then it should remove the secret and keep the runs", () => {
                const run = LETTER_RUN_AROUND_MATCHES;
                assert.equal(
                    declaring(defaultRedactor(), TOKEN_NAME, TOKEN).text(`${run}${TOKEN}${run}`),
                    `${run}${SECRET_PLACEHOLDER}${run}`,
                );
            });
        });
    });

    describe("given a secret that starts with white space", () => {
        for (const { name, unit } of WHITE_SPACE_RUNS) {
            describe(`and a long run of ${name} that does not lead to it`, () => {
                describe("when a text four times as long is redacted", () => {
                    test("then it should take about four times as long", () => {
                        const redactor = declaring(REDACTOR_OF_NOTHING, SPACED_NAME, SPACED_VALUE);
                        assertTimeGrowsInStepWithLength(
                            quickestTimings(
                                (text) => redactor.text(text),
                                (length) => unit.repeat(length),
                                WHITE_SPACE_RUN_LENGTH,
                            ),
                        );
                    });
                });

                describe("when it is redacted", () => {
                    test("then it should give the text unchanged", () => {
                        const text = unit.repeat(WHITE_SPACE_RUN_LENGTH);
                        assert.equal(
                            declaring(REDACTOR_OF_NOTHING, SPACED_NAME, SPACED_VALUE).text(text),
                            text,
                        );
                    });
                });
            });
        }

        describe("when text holding it as typed is redacted", () => {
            test("then it should replace the secret with its leading space", () => {
                assert.equal(
                    redactingSpacedPassword().text(`before${SPACED_VALUE} after`),
                    `before${SECRET_PLACEHOLDER} after`,
                );
            });
        });

        describe("when text holding it with a tab for its space is redacted", () => {
            test("then it should remove the secret and keep the rest", () => {
                const redacted = redactingSpacedPassword().text(`before\t${SPACED_WORDS} after`);
                assert.equal(redacted.includes(SPACED_WORDS), false, redacted);
                assert.ok(redacted.startsWith("before"), redacted);
                assert.ok(redacted.endsWith(" after"), redacted);
            });
        });

        describe("when text holding it after a long run of spaces is redacted", () => {
            test("then it should remove the secret and keep what follows", () => {
                const run = " ".repeat(WHITE_SPACE_RUN_LENGTH);
                const redacted = redactingSpacedPassword().text(`${run}${SPACED_WORDS} after`);
                assert.equal(redacted.includes(SPACED_WORDS), false, redacted.slice(-60));
                assert.ok(redacted.endsWith(" after"), redacted.slice(-60));
            });
        });

        describe("when text holding it URL-encoded after a long run of spaces is redacted", () => {
            test("then it should remove the secret", () => {
                const run = " ".repeat(WHITE_SPACE_RUN_LENGTH);
                const echo = encodeURIComponent(SPACED_VALUE);
                const redacted = redactingSpacedPassword().text(`${run}${echo} after`);
                assert.equal(redacted.includes(echo), false, redacted.slice(-60));
                assert.equal(
                    redacted.includes(encodeURIComponent(SPACED_WORDS)),
                    false,
                    redacted.slice(-60),
                );
                assert.ok(redacted.endsWith(" after"), redacted.slice(-60));
            });
        });
    });
});
