import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseAudit } from "../../../packages/driver-cdp/src/capabilities/ParseAudit.ts";

const NODE = {
    selector: "img:nth-of-type(1)",
    box: { x: 1, y: 2, width: 30, height: 40 },
    offscreen: false,
    snippet: "<img>",
};
const RULE = {
    ruleId: "image-alt",
    actRule: "23a2a8",
    wcag: ["1.1.1"],
    impact: "critical",
    nodes: [NODE],
};
const SECOND_RULE = { ...RULE, ruleId: "button-name", actRule: null, wcag: ["4.1.2"] };

// Text the page controls, distinctive enough that any echo of it is plain.
const PAGE_TEXT = "PLANTED-PAGE-TEXT-7f3a9c";
const OTHER_PAGE_TEXT = "OTHER-PLANTED-TEXT-0b21e4";

// The refusal as JSON, whatever its shape, or a failed assertion when the report is read.
function refusalOf(json: string): string {
    const parsed = parseAudit(json);
    if (parsed.ok) {
        assert.fail(`the report was read: ${json}`);
    }
    const refusal: unknown = parsed.error;
    return JSON.stringify(refusal);
}

describe("Using the audit report reader", () => {
    describe("given a report of failing rules in the shape the page sends", () => {
        describe("when it is read", () => {
            test("then it should give the rules", () => {
                assert.deepEqual(parseAudit(JSON.stringify([RULE, SECOND_RULE])), {
                    ok: true,
                    value: [RULE, SECOND_RULE],
                });
            });
        });
    });

    describe("given a rule whose impact is not one it knows", () => {
        describe("when it is read", () => {
            test("then it should refuse the report", () => {
                assert.notEqual(
                    refusalOf(JSON.stringify([{ ...RULE, impact: "catastrophic" }])),
                    "",
                );
            });
        });
    });

    describe("given a rule id the page audit does not define", () => {
        describe("when it is read", () => {
            test("then it should refuse the report", () => {
                assert.notEqual(
                    refusalOf(JSON.stringify([{ ...RULE, ruleId: "made-up-rule" }])),
                    "",
                );
            });
        });
    });

    describe("given a report that is not JSON", () => {
        describe("when it is read", () => {
            test("then it should refuse it, with a reason and no throw", () => {
                assert.notEqual(refusalOf("[{not json"), "");
            });
        });
    });

    describe("given a report that is JSON but not a list", () => {
        describe("when it is read", () => {
            test("then it should refuse an object, with a reason and no throw", () => {
                assert.notEqual(refusalOf(JSON.stringify({ rules: [RULE] })), "");
            });

            test("then it should refuse a string, with a reason and no throw", () => {
                assert.notEqual(refusalOf(JSON.stringify("image-alt")), "");
            });
        });
    });

    describe("given a rule with no failing elements listed", () => {
        describe("when it is read", () => {
            test("then it should refuse the report, with a reason and no throw", () => {
                const withoutNodes = {
                    ruleId: RULE.ruleId,
                    actRule: RULE.actRule,
                    wcag: RULE.wcag,
                    impact: RULE.impact,
                };
                assert.notEqual(refusalOf(JSON.stringify([withoutNodes])), "");
            });
        });

        describe("and its nodes are a string that has a length", () => {
            describe("when it is read", () => {
                test("then it should refuse the report, with a reason and no throw", () => {
                    assert.notEqual(refusalOf(JSON.stringify([{ ...RULE, nodes: "xx" }])), "");
                });
            });
        });
    });

    describe("given a failing element with a box of the wrong shape, deep in the report", () => {
        describe("when it is read", () => {
            test("then it should name where, as an index path", () => {
                const report = [
                    RULE,
                    { ...SECOND_RULE, nodes: [NODE, { ...NODE, box: "nowhere" }] },
                ];
                assert.ok(refusalOf(JSON.stringify(report)).includes("[1].nodes[1].box"));
            });
        });
    });

    describe("given page text in the fields of a report it refuses", () => {
        const refusalsWith = (text: string): readonly string[] => [
            refusalOf(JSON.stringify([{ ...RULE, ruleId: text }])),
            refusalOf(JSON.stringify([{ ...RULE, impact: text }])),
            refusalOf(JSON.stringify([{ ...RULE, ruleId: text, nodes: text }])),
            refusalOf(JSON.stringify([{ ...RULE, ruleId: text, wcag: text }])),
            refusalOf(
                JSON.stringify([{ ...RULE, nodes: [{ ...NODE, snippet: text, box: text }] }]),
            ),
            refusalOf(
                JSON.stringify([
                    { ...RULE, nodes: [{ ...NODE, selector: text, offscreen: text }] },
                ]),
            ),
            refusalOf(`[{"ruleId": "${text}", `),
        ];

        describe("when it is read", () => {
            test("then it should echo none of that text", () => {
                assert.deepEqual(
                    refusalsWith(PAGE_TEXT).filter((refusal) => refusal.includes(PAGE_TEXT)),
                    [],
                );
            });

            test("then it should refuse the same way whatever the text", () => {
                assert.deepEqual(refusalsWith(PAGE_TEXT), refusalsWith(OTHER_PAGE_TEXT));
            });
        });
    });
});
