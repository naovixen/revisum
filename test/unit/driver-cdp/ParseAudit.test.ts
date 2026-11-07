import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseAudit } from "../../../packages/driver-cdp/src/ParseAudit.ts";

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

// The reason a report is refused, or a failed assertion when it is read.
function refusalOf(json: string): string {
    const parsed = parseAudit(json);
    if (parsed.ok) {
        assert.fail(`the report was read: ${json}`);
    }
    return parsed.error;
}

describe("Using the audit report reader", () => {
    describe("given a report of failing rules in the shape the page sends", () => {
        describe("when it is read", () => {
            test("then it should give the rules", () => {
                assert.deepEqual(parseAudit(JSON.stringify([RULE])), { ok: true, value: [RULE] });
            });
        });

        describe("and a rule's impact is not one it knows", () => {
            describe("when it is read", () => {
                test("then it should give the rule with an unknown impact", () => {
                    assert.deepEqual(
                        parseAudit(JSON.stringify([{ ...RULE, impact: "catastrophic" }])),
                        { ok: true, value: [{ ...RULE, impact: "unknown" }] },
                    );
                });
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
});
