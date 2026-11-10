// A PNG can carry text deflated, where no search of its raw bytes finds it. The scanner has to inflate
// a zTXt chunk, and an iTXt chunk with its compression flag set, or a secret leaves in an image a
// scan called clean. Everything here is planted and made up for the test.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { deflateSync } from "node:zlib";
import { leakScanner } from "@revisum/engine";
import { fakeSecretValue, resolvedSecret } from "../examples/SecretRun.ts";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const SEPARATOR = [0];
const DEFLATE_METHOD = [0];
const COMPRESSED = [1];
const NOT_COMPRESSED = [0];
const KEYWORD = [...Buffer.from("Comment", "latin1")];
const LANGUAGE_TAG = [...Buffer.from("en", "latin1")];
const TRANSLATED_KEYWORD = [...Buffer.from("Kommentar", "utf8")];
const NOT_DEFLATE = [...Buffer.from("this is no deflate stream", "latin1")];

const deflated = (text: string): readonly number[] => [...deflateSync(Buffer.from(text, "utf8"))];

// One chunk as a PNG writes it: length, type, data and a checksum nothing here reads.
function chunk(type: string, data: readonly number[]): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), Buffer.from(data), Buffer.alloc(4)]);
}

const pngWith = (...chunks: readonly Buffer[]): Buffer =>
    Buffer.concat([Buffer.from(SIGNATURE), ...chunks, chunk("IEND", [])]);

const zTxtData = (compressed: readonly number[]): readonly number[] => [
    ...KEYWORD,
    ...SEPARATOR,
    ...DEFLATE_METHOD,
    ...compressed,
];

const iTxtData = (flag: readonly number[], text: readonly number[]): readonly number[] => [
    ...KEYWORD,
    ...SEPARATOR,
    ...flag,
    ...DEFLATE_METHOD,
    ...LANGUAGE_TAG,
    ...SEPARATOR,
    ...TRANSLATED_KEYWORD,
    ...SEPARATOR,
    ...text,
];

const PNGS_HOLDING_THE_VALUE: readonly {
    readonly name: string;
    readonly png: (value: string) => Buffer;
}[] = [
    {
        name: "a zTXt chunk",
        png: (value) => pngWith(chunk("zTXt", zTxtData(deflated(`token=${value}`)))),
    },
    {
        name: "an iTXt chunk with its compression flag set",
        png: (value) => pngWith(chunk("iTXt", iTxtData(COMPRESSED, deflated(`token=${value}`)))),
    },
    {
        name: "a zTXt chunk after another chunk",
        png: (value) =>
            pngWith(
                chunk("tEXt", [...KEYWORD, ...SEPARATOR, 65]),
                chunk("zTXt", zTxtData(deflated(value))),
            ),
    },
];

const PADDING_PAST_THE_LIMIT = "x".repeat(17 * 1024 * 1024);

const CHUNKS_INFLATING_PAST_THE_LIMIT: readonly {
    readonly name: string;
    readonly type: string;
    readonly data: (compressed: readonly number[]) => readonly number[];
}[] = [
    { name: "a zTXt chunk", type: "zTXt", data: zTxtData },
    {
        name: "an iTXt chunk",
        type: "iTXt",
        data: (compressed) => iTxtData(COMPRESSED, compressed),
    },
];

const SECRET_PLACES_AROUND_THE_PADDING: readonly {
    readonly order: string;
    readonly text: (value: string) => string;
}[] = [
    { order: "before", text: (value) => `token=${value}${PADDING_PAST_THE_LIMIT}` },
    { order: "after", text: (value) => `${PADDING_PAST_THE_LIMIT}token=${value}` },
];

let folder: string;
before(() => {
    folder = mkdtempSync(join(tmpdir(), "leak-scanner-png-"));
});
after(() => {
    rmSync(folder, { recursive: true, force: true });
});

function formsFoundIn(fileName: string, bytes: Buffer, value: string): readonly string[] {
    const path = join(folder, fileName);
    writeFileSync(path, bytes);
    const secret = resolvedSecret("ACCOUNT_TOKEN", value);
    return leakScanner()
        .scan([path], [secret])
        .map((leak) => leak.form);
}

describe("Using the leak scanner", () => {
    for (const [index, { name, png }] of PNGS_HOLDING_THE_VALUE.entries()) {
        describe(`given a PNG with a secret deflated in ${name}`, () => {
            describe("when the file is scanned", () => {
                test("then it should report the leak as the value itself", () => {
                    const value = fakeSecretValue();
                    assert.deepEqual(formsFoundIn(`held-${index}.png`, png(value), value), ["raw"]);
                });
            });
        });

        describe(`given a PNG with another text deflated in ${name}`, () => {
            describe("when the file is scanned", () => {
                test("then it should report nothing", () => {
                    assert.deepEqual(
                        formsFoundIn(
                            `other-${index}.png`,
                            png("nothing to see here"),
                            fakeSecretValue(),
                        ),
                        [],
                    );
                });
            });
        });
    }

    describe("given a PNG with a secret written plainly in an iTXt chunk marked as not compressed", () => {
        describe("when the file is scanned", () => {
            test("then it should report the leak", () => {
                const value = fakeSecretValue();
                const text = [...Buffer.from(value, "utf8")];
                const bytes = pngWith(chunk("iTXt", iTxtData(NOT_COMPRESSED, text)));
                assert.ok(formsFoundIn("plain-itxt.png", bytes, value).includes("raw"));
            });
        });
    });

    for (const { name, data } of [
        { name: "a zTXt chunk", data: zTxtData(NOT_DEFLATE) },
        { name: "an iTXt chunk", data: iTxtData(COMPRESSED, NOT_DEFLATE) },
    ]) {
        describe(`given a PNG with bytes in ${name} that do not inflate`, () => {
            describe("when the file is scanned", () => {
                test("then it should report a raw leak and not throw", () => {
                    const type = name.includes("zTXt") ? "zTXt" : "iTXt";
                    const bytes = pngWith(chunk(type, data));
                    assert.deepEqual(formsFoundIn(`broken-${type}.png`, bytes, fakeSecretValue()), [
                        "raw",
                    ]);
                });
            });
        });
    }

    for (const { name, type, data } of CHUNKS_INFLATING_PAST_THE_LIMIT) {
        for (const { order, text } of SECRET_PLACES_AROUND_THE_PADDING) {
            describe(`given a PNG with ${name} that inflates past the limit, the secret ${order} the padding`, () => {
                describe("when the file is scanned", () => {
                    test("then it should report a raw leak", () => {
                        const value = fakeSecretValue();
                        const bytes = pngWith(chunk(type, data(deflated(text(value)))));
                        assert.deepEqual(
                            formsFoundIn(`too-long-${type}-${order}.png`, bytes, value),
                            ["raw"],
                        );
                    });
                });
            });
        }
    }
});
