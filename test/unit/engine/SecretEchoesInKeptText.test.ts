// What a page shows or holds of a secret must not reach what a run keeps, whichever way it is written.
// A secret's spaces may be collapsed before it is compared; JSON and HTML may escape its characters;
// and a remember step must not copy a secret-filled field, whose hash a short secret cannot survive.
// All values here are made up for these tests.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { leakScanner, sha256 } from "@revisum/engine";
import { echoPageDriver, holdsSecret } from "./echo-page-driver.ts";
import {
    FAKE_TARGET,
    fakeSecretOfLength,
    resolvedSecret,
    runWithSecrets,
    type SecretRun,
} from "./secret-examples.ts";

const SECRET = "ACCOUNT_PASSWORD";
const PASSWORD_FIELD = { by: "label", label: "Password" };
const PLAIN_FIELD = { by: "label", label: "Display name" };
const OTHER_FIELD = { by: "label", label: "Nickname" };
const ECHO = { by: "testId", testId: "echo" };

let folder: string;
before(() => {
    folder = mkdtempSync(join(tmpdir(), "secret-echoes-"));
});
after(() => {
    rmSync(folder, { recursive: true, force: true });
});

let planted = 0;
function plantedFile(content: string): string {
    planted += 1;
    const path = join(folder, `echo-${planted}.log`);
    writeFileSync(path, content);
    return path;
}

const planOf = (steps: readonly unknown[]) => ({
    version: "1.3",
    meta: {
        featureId: "SECRETS-7",
        specReference: "specs/secrets.md#kept-text",
        title: "Echoes in kept text",
    },
    targets: [FAKE_TARGET],
    steps,
});

// A run that types the secret, then checks an element showing `text` against a text it can never
// equal, so the failed step keeps what it observed.
async function observedAfterEcho(secretValue: string, text: string) {
    const plan = planOf([
        { type: "navigate", url: "/" },
        { type: "fill", locator: PASSWORD_FIELD, value: { secretName: SECRET } },
        {
            type: "expect",
            locator: ECHO,
            assert: { kind: "textEquals", value: "deliberately wrong" },
            criterionId: "secrets.echo-checked",
        },
    ]);
    const driver = echoPageDriver({
        secretValues: { [SECRET]: secretValue },
        texts: { echo: text },
    });
    const ran = await runWithSecrets([SECRET], plan, { [SECRET]: secretValue }, driver);
    const check = ran.result.steps[2];
    assert.equal(check?.outcome, "failed", JSON.stringify(ran.result.steps));
    return { observed: check.observed ?? "", everything: ran.everything };
}

// ---- A secret that holds two spaces ------------------------------------------------------------

// The first has a first word too short to reach the prefix search; the second a first word long
// enough, so the prefix search takes that word and could leave the others behind.
const SPACED_SECRETS: readonly string[] = ["tea  for  two  please", "test-only  horse  battery"];
const collapsed = (text: string): string => text.replace(/ +/g, " ");
const wordsOf = (text: string): readonly string[] => text.split(/ +/);
const SHORT_SPACED_SECRET = "ab  cd";
const SHORT_SPACED_SECRET_COLLAPSED = "ab cd";

// ---- Secrets JSON and HTML write differently ---------------------------------------------------

// Characters JSON and HTML rewrite come early and throughout, so no run of the value as typed is
// long enough for the prefix search to find it.
const ESCAPABLE_SECRET = `t"s\\t<o&n'l>y"f\\a<k&e`;
const SECRET_PIECES: readonly string[] = ["s\\t", "<o", "n'l", "f\\a", "k&e"];

const htmlNamed = (text: string): string =>
    text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
const everyEscapable = (text: string, write: (codePoint: number) => string): string =>
    text.replace(/[&<>"']/g, (character) => write(character.codePointAt(0) ?? 0));

const jsonText = (text: string): string => JSON.stringify(text).slice(1, -1);
const jsonWithEscapedMarkup = (text: string): string =>
    jsonText(text).replace(
        /[&<>']/g,
        (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
    );

const ENCODED_ECHOES: readonly { readonly title: string; readonly text: string }[] = [
    { title: "JSON-escaped", text: jsonText(ESCAPABLE_SECRET) },
    {
        title: "JSON-escaped with its markup written as \\u escapes",
        text: jsonWithEscapedMarkup(ESCAPABLE_SECRET),
    },
    { title: "HTML-encoded with named entities", text: htmlNamed(ESCAPABLE_SECRET) },
    {
        title: "HTML-encoded with decimal entities",
        text: everyEscapable(ESCAPABLE_SECRET, (codePoint) => `&#${codePoint};`),
    },
    {
        title: "HTML-encoded with hex entities",
        text: everyEscapable(ESCAPABLE_SECRET, (codePoint) => `&#x${codePoint.toString(16)};`),
    },
];

const NEAR_MISSES: readonly { readonly title: string; readonly text: string }[] = [
    { title: "JSON-escaped", text: jsonText(`t"x\\t<o&n'l>y"f\\a<k&e`) },
    { title: "HTML-encoded", text: htmlNamed(`t"x\\t<o&n'l>y"f\\a<k&e`) },
];

// ---- Remembering from a secret-filled field ----------------------------------------------------

type JsonRecordLike = Readonly<Record<string, unknown>>;

const rememberFrom = (field: JsonRecordLike, fillValue: unknown): readonly unknown[] => [
    { type: "navigate", url: "/" },
    { type: "fill", locator: field, value: fillValue },
    { type: "remember", name: "copied", from: { element: field, read: "value" } },
    { type: "fill", locator: OTHER_FIELD, value: { valueName: "copied" } },
    {
        type: "expect",
        locator: OTHER_FIELD,
        assert: { kind: "visible" },
        criterionId: "secrets.copied-shown",
    },
];

type RememberRun = {
    readonly run: SecretRun;
    readonly copiedInto: string | undefined;
};

async function rememberRun(
    value: string,
    field: JsonRecordLike,
    fillValue: unknown,
): Promise<RememberRun> {
    const driver = echoPageDriver({ secretValues: { [SECRET]: value } });
    const run = await runWithSecrets(
        [SECRET],
        planOf(rememberFrom(field, fillValue)),
        { [SECRET]: value },
        driver,
    );
    return { run, copiedInto: driver.fieldValues.get(`label:${OTHER_FIELD.label}`) };
}

describe("Using a run", () => {
    for (const secret of SPACED_SECRETS) {
        describe(`given the secret "${secret}", which holds two spaces`, () => {
            for (const { title, shown } of [
                { title: "as typed", shown: secret },
                { title: "with its spaces collapsed", shown: collapsed(secret) },
            ]) {
                describe(`and the page echoes it ${title}`, () => {
                    describe("when a failed check keeps what it saw", () => {
                        test("then it should keep none of its words", async () => {
                            const { observed, everything } = await observedAfterEcho(
                                secret,
                                `Your phrase is ${shown} today`,
                            );
                            assert.deepEqual(
                                wordsOf(secret).filter((word) => observed.includes(word)),
                                [],
                                observed,
                            );
                            assert.equal(holdsSecret(everything, collapsed(secret)), false);
                        });
                    });
                });
            }
        });
    }

    describe("given a secret that holds two spaces", () => {
        describe("and the page shows some other text", () => {
            describe("when a failed check keeps what it saw", () => {
                test("then it should keep that text", async () => {
                    const { observed } = await observedAfterEcho(
                        "tea  for  two  please",
                        "Nothing to see  here",
                    );
                    assert.equal(observed, "Nothing to see here");
                });
            });
        });
    });

    describe("given a secret too short to search for that holds two spaces", () => {
        describe("and the whole of an element's text is that secret", () => {
            describe("when a failed check keeps what it saw", () => {
                test("then it should not keep it", async () => {
                    const { observed } = await observedAfterEcho(
                        SHORT_SPACED_SECRET,
                        SHORT_SPACED_SECRET,
                    );
                    assert.equal(observed.includes(SHORT_SPACED_SECRET_COLLAPSED), false, observed);
                });
            });
        });
    });

    describe("given a secret with one space between its words", () => {
        describe("and the page echoes it", () => {
            describe("when a failed check keeps what it saw", () => {
                test("then it should not keep it", async () => {
                    const { observed } = await observedAfterEcho(
                        "test-only horse battery",
                        "Your phrase is test-only horse battery today",
                    );
                    assert.equal(holdsSecret(observed, "test-only horse battery"), false, observed);
                });
            });
        });
    });

    for (const { title, text } of ENCODED_ECHOES) {
        describe(`given a secret echoed ${title}`, () => {
            describe("when a failed check keeps what it saw", () => {
                test("then it should keep none of the secret", async () => {
                    const { observed } = await observedAfterEcho(
                        ESCAPABLE_SECRET,
                        `Saved: ${text}`,
                    );
                    assert.equal(observed.includes(text), false, observed);
                    assert.deepEqual(
                        SECRET_PIECES.filter((piece) => observed.includes(piece)),
                        [],
                        observed,
                    );
                });
            });
        });
    }

    for (const { title, text } of NEAR_MISSES) {
        describe(`given another value echoed ${title}`, () => {
            describe("when a failed check keeps what it saw", () => {
                test("then it should keep that value", async () => {
                    const { observed } = await observedAfterEcho(
                        ESCAPABLE_SECRET,
                        `Saved: ${text}`,
                    );
                    assert.equal(observed, `Saved: ${text}`);
                });
            });
        });
    }

    describe("given a remember step that reads a field filled with a secret", () => {
        describe("when it runs", () => {
            const value = fakeSecretOfLength(24);

            test("then it should fail the step with a code", async () => {
                const { run } = await rememberRun(value, PASSWORD_FIELD, { secretName: SECRET });
                const step = run.result.steps[2];
                assert.equal(step?.outcome, "failed", JSON.stringify(step));
                assert.equal(typeof step.code, "string");
                assert.notEqual(step.code, "");
                assert.notEqual(step.code, "unsupported-step");
            });

            test("then it should keep no hash of the secret", async () => {
                const { run } = await rememberRun(value, PASSWORD_FIELD, { secretName: SECRET });
                assert.equal(run.everything.includes(sha256(value)), false, run.everything);
            });

            test("then it should not hand the secret to a later step", async () => {
                const { copiedInto } = await rememberRun(value, PASSWORD_FIELD, {
                    secretName: SECRET,
                });
                assert.equal(copiedInto, undefined);
            });
        });
    });

    describe("given a remember step that reads a field filled with plain text", () => {
        describe("when it runs", () => {
            test("then it should remember the value and use it later", async () => {
                const { run, copiedInto } = await rememberRun(
                    "anything",
                    PLAIN_FIELD,
                    "Ordinary words",
                );
                assert.equal(
                    run.result.steps[2]?.outcome,
                    "passed",
                    JSON.stringify(run.result.steps),
                );
                assert.equal(copiedInto, "Ordinary words");
            });
        });
    });
});

describe("Using the leak scanner", () => {
    for (const { title, text } of ENCODED_ECHOES) {
        describe(`given a file holding a secret ${title}`, () => {
            describe("when the file is scanned", () => {
                test("then it should report the leak", () => {
                    const path = plantedFile(`Saved: ${text}`);
                    const secret = resolvedSecret(SECRET, ESCAPABLE_SECRET);
                    const leaks = leakScanner().scan([path], [secret]);
                    assert.ok(
                        leaks.some((leak) => leak.secret === secret.name && leak.file === path),
                        `no leak reported in: ${text}`,
                    );
                });
            });
        });
    }

    for (const { title, text } of NEAR_MISSES) {
        describe(`given a file holding another value ${title}`, () => {
            describe("when the file is scanned", () => {
                test("then it should report nothing", () => {
                    const path = plantedFile(`Saved: ${text}`);
                    assert.deepEqual(
                        leakScanner().scan([path], [resolvedSecret(SECRET, ESCAPABLE_SECRET)]),
                        [],
                    );
                });
            });
        });
    }
});
