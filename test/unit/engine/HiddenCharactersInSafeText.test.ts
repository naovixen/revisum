// Safe text is shown to the person who approves a plan, so what they read must be what it holds. A
// character with no width, a mark that reorders text, a C1 control or a hidden line break can make
// one line read as another. The rule for script sources already refuses hidden line breaks.
// The two joiners stay allowed: emoji and Persian and Indic text need them to read as they should.
// Pages hold such characters without anyone writing them into a plan, so text made at run time is
// kept, and only a control character or a mark that overrides direction is kept as a digest.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isUnsafeText, runTimeText, runTimeTextOrDigest } from "@revisum/engine";
import { accepted, parserFor, planOf, rejection } from "./run-value-examples.ts";

const parsePlan = parserFor();

const HIDDEN_CHARACTERS: readonly { readonly name: string; readonly character: string }[] = [
    { name: "zero width space U+200B", character: "​" },
    { name: "word joiner U+2060", character: "⁠" },
    { name: "byte order mark U+FEFF", character: "﻿" },
    { name: "left-to-right mark U+200E", character: "‎" },
    { name: "right-to-left mark U+200F", character: "‏" },
    { name: "Arabic letter mark U+061C", character: "؜" },
    { name: "C1 control U+0080", character: "\u0080" },
    { name: "next line U+0085", character: "\u0085" },
    { name: "C1 control U+009F", character: "\u009f" },
    { name: "line separator U+2028", character: " " },
    { name: "paragraph separator U+2029", character: " " },
];

const VISIBLE_TEXTS: readonly { readonly name: string; readonly text: string }[] = [
    { name: "accented Latin", text: "Crème brûlée" },
    { name: "Japanese", text: "注文を確認" },
    { name: "Arabic", text: "تأكيد" },
    { name: "emoji", text: "Order placed \u{1f44d}" },
    { name: "emoji with a zero width joiner U+200D", text: "Run by \u{1f469}\u200d\u{1f4bb}" },
    {
        name: "a Persian word with a zero width non-joiner U+200C",
        text: "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
    },
];

const REFUSED_AT_RUN_TIME: readonly { readonly name: string; readonly character: string }[] = [
    { name: "control character U+0007", character: "\u0007" },
    { name: "direction override U+202E", character: "\u202e" },
    { name: "direction isolate U+2066", character: "\u2066" },
];

const planTitled = (title: string) =>
    planOf([], {
        meta: { featureId: "ORDERS-1", specReference: "specs/orders.md#new-order", title },
    });

describe("Using safe text", () => {
    for (const { name, character } of HIDDEN_CHARACTERS) {
        describe(`given text holding a ${name}`, () => {
            const text = `Pay${character}now`;

            describe("when the text is judged", () => {
                test("then it should call it unsafe", () => {
                    assert.equal(isUnsafeText(text), true);
                });
            });

            describe("when a plan holds it", () => {
                test("then it should refuse the plan as unsafe_text", () => {
                    assert.deepEqual(rejection(parsePlan, planTitled(text)), [
                        "unsafe_text $.meta.title",
                    ]);
                });
            });

            describe("when it is made at run time", () => {
                test("then it should keep the text", () => {
                    assert.equal(runTimeText(text, 100), text);
                });

                test("then it should keep the text in place of a digest", () => {
                    assert.equal(runTimeTextOrDigest(text, 100), text);
                });
            });
        });
    }

    for (const { name, character } of REFUSED_AT_RUN_TIME) {
        describe(`given text holding a ${name}`, () => {
            const text = `Pay${character}now`;

            describe("when it is made at run time", () => {
                test("then it should not brand it", () => {
                    assert.equal(runTimeText(text, 100), undefined);
                });

                test("then it should keep its digest in its place", () => {
                    assert.match(runTimeTextOrDigest(text, 100), /^sha256:[0-9a-f]{64}$/);
                });
            });
        });
    }

    for (const { name, text } of VISIBLE_TEXTS) {
        describe(`given text in ${name}`, () => {
            describe("when the text is judged", () => {
                test("then it should call it safe", () => {
                    assert.equal(isUnsafeText(text), false);
                });
            });

            describe("when a plan holds it", () => {
                test("then it should accept the plan", () => {
                    assert.equal(accepted(parsePlan, planTitled(text)).meta.title, text);
                });
            });

            describe("when it is made at run time", () => {
                test("then it should keep the text", () => {
                    assert.equal(runTimeText(text, 100), text);
                });
            });
        });
    }
});
