// A list of blocked origins can be read as everything a page tried. It is not: WebRTC and WebTransport
// are off in browser sessions, so they leave nothing to refuse, and the list holds only what was refused
// and seen. So wherever a report shows the list, it says so. A report whose input carries no list keeps
// today's words.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generate, parseReportInput, type Output } from "@revisum/report";
import {
    ALL_KINDS,
    assetsOf,
    byKind,
    loaded,
    outputText,
    outputs,
    reportHtml,
} from "../../support/report-fixtures.ts";

const REFUSED_ORIGINS = ["https://first-refused.example", "second-refused.example:443"];

const SAYS_THE_CHANNELS_ARE_OFF: readonly RegExp[] = [/WebRTC/, /WebTransport/, /\boff\b/];
const SAYS_THE_LIST_IS_PARTIAL: readonly RegExp[] = [/refused and seen/i, /not every attempt/i];
const NAMES_A_CHANNEL = /WebRTC|WebTransport/;

// The functional report's files, generated from its input as the parser takes it, with the run's blocked
// origins in it.
function filesOfRunBlocking(blockedOrigins: readonly string[]): readonly Output[] {
    const report = byKind("functional");
    const parsed = parseReportInput(
        JSON.parse(JSON.stringify({ ...report, run: { ...report.run, blockedOrigins } })),
    );
    assert.ok(parsed.ok, JSON.stringify(parsed));
    return generate(parsed.value, assetsOf(report), loaded.history);
}

// What a person reads: no markup between the words.
const readableText = (html: string): string =>
    html
        .replace(/<style>.*?<\/style>/gs, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ");

const readableReport = (files: readonly Output[]): string =>
    readableText(outputText(files, "report.html"));

const assertSaysAll = (text: string, patterns: readonly RegExp[]): void => {
    for (const pattern of patterns) {
        assert.match(text, pattern);
    }
};

describe("Using the report", () => {
    describe("given a run that refused origins", () => {
        describe("when the report is generated", () => {
            test("then it should list each refused origin", () => {
                const text = readableReport(filesOfRunBlocking(REFUSED_ORIGINS));
                for (const origin of REFUSED_ORIGINS) {
                    assert.ok(text.includes(origin), origin);
                }
            });

            test("then it should say WebRTC and WebTransport are off", () => {
                const text = readableReport(filesOfRunBlocking(REFUSED_ORIGINS));
                assertSaysAll(text, SAYS_THE_CHANNELS_ARE_OFF);
            });

            test("then it should say the list shows what was refused and seen, not every attempt", () => {
                const text = readableReport(filesOfRunBlocking(REFUSED_ORIGINS));
                assertSaysAll(text, SAYS_THE_LIST_IS_PARTIAL);
            });

            test("then it should say the same in a PR comment that lists them", () => {
                const comment = outputText(filesOfRunBlocking(REFUSED_ORIGINS), "pr-comment.md");
                if (REFUSED_ORIGINS.some((origin) => comment.includes(origin))) {
                    assertSaysAll(comment, [
                        ...SAYS_THE_CHANNELS_ARE_OFF,
                        ...SAYS_THE_LIST_IS_PARTIAL,
                    ]);
                }
            });
        });
    });

    describe("given a run that refused nothing", () => {
        describe("when the report is generated", () => {
            test("then it should still say the channels are off, since an empty list does not mean nothing was tried", () => {
                const text = readableReport(filesOfRunBlocking([]));
                assertSaysAll(text, [...SAYS_THE_CHANNELS_ARE_OFF, ...SAYS_THE_LIST_IS_PARTIAL]);
            });
        });
    });

    for (const kind of ALL_KINDS) {
        describe(`given the ${kind} report, whose input carries no blocked origins`, () => {
            describe("when the report is generated", () => {
                test("then it should name neither channel, as it shows no list to explain", () => {
                    const report = byKind(kind);
                    assert.doesNotMatch(readableText(reportHtml(report)), NAMES_A_CHANNEL);
                    assert.doesNotMatch(
                        outputText(outputs(report), "pr-comment.md"),
                        NAMES_A_CHANNEL,
                    );
                });
            });
        });
    }
});
