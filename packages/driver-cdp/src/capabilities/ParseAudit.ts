// Reads what pageAudit (PageAudit.ts) reports from the page. The page's own scripts may have changed
// what the browser hands back, so every field is checked and a report of any other shape is refused.
// A refusal names a fixed code and the index path of the field, never the page's text.
import {
    failure,
    IMPACTS,
    isNonArrayObject,
    success,
    type A11yFinding,
    type Box,
    type Impact,
    type Result,
} from "@revisum/contracts";
import { PAGE_AUDIT_RULES } from "./PageAuditRules.ts";

export type AuditNode = {
    readonly selector: string;
    // Page css pixels at scroll position 0; null when the element has no box.
    readonly box: Box | null;
    // True when the box lies wholly outside the viewport, so it is not in the screenshot.
    readonly offscreen: boolean;
    readonly snippet: string;
};
export type AuditRuleResult = {
    readonly ruleId: string;
    // The W3C ACT rule the check follows, where one exists.
    readonly actRule: string | null;
    readonly wcag: readonly string[];
    readonly impact: Impact;
    readonly nodes: readonly AuditNode[];
};

export const AuditReportProblemCode = {
    InvalidJson: "invalid_json",
    WrongType: "wrong_type",
    UnknownValue: "unknown_value",
} as const;
export type AuditReportProblemCode =
    (typeof AuditReportProblemCode)[keyof typeof AuditReportProblemCode];
// Why a report was refused, and where: `$` is the report, `$[1].nodes[0].box` a field inside it.
export type AuditReportProblem = { readonly code: AuditReportProblemCode; readonly path: string };

type Read<Value> = Result<Value, AuditReportProblem>;

const wrongType = (path: string): Read<never> =>
    failure({ code: AuditReportProblemCode.WrongType, path });

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

const isStringList = (value: unknown): value is readonly string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");

function readBox(value: unknown, path: string): Read<Box | null> {
    if (value === null) {
        return success(null);
    }
    if (!isNonArrayObject(value)) {
        return wrongType(path);
    }
    const { x, y, width, height } = value;
    return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && isFiniteNumber(height)
        ? success({ x, y, width, height })
        : wrongType(path);
}

function readNode(value: unknown, path: string): Read<AuditNode> {
    if (!isNonArrayObject(value)) {
        return wrongType(path);
    }
    const { selector, offscreen, snippet } = value;
    if (typeof selector !== "string") {
        return wrongType(`${path}.selector`);
    }
    const box = readBox(value["box"], `${path}.box`);
    if (!box.ok) {
        return box;
    }
    if (typeof offscreen !== "boolean") {
        return wrongType(`${path}.offscreen`);
    }
    if (typeof snippet !== "string") {
        return wrongType(`${path}.snippet`);
    }
    return success({ selector, box: box.value, offscreen, snippet });
}

function readNodes(value: unknown, path: string): Read<readonly AuditNode[]> {
    if (!Array.isArray(value)) {
        return wrongType(path);
    }
    const nodes: AuditNode[] = [];
    for (const [index, node] of value.entries()) {
        const read = readNode(node, `${path}[${String(index)}]`);
        if (!read.ok) {
            return read;
        }
        nodes.push(read.value);
    }
    return success(nodes);
}

function readRule(value: unknown, path: string): Read<AuditRuleResult> {
    if (!isNonArrayObject(value)) {
        return wrongType(path);
    }
    const { ruleId, actRule, wcag, impact } = value;
    if (typeof ruleId !== "string" || !Object.hasOwn(PAGE_AUDIT_RULES, ruleId)) {
        return failure({ code: AuditReportProblemCode.UnknownValue, path: `${path}.ruleId` });
    }
    if (actRule !== null && typeof actRule !== "string") {
        return wrongType(`${path}.actRule`);
    }
    if (!isStringList(wcag)) {
        return wrongType(`${path}.wcag`);
    }
    const knownImpact = IMPACTS.find((known) => known === impact);
    if (knownImpact === undefined) {
        return failure({ code: AuditReportProblemCode.UnknownValue, path: `${path}.impact` });
    }
    const nodes = readNodes(value["nodes"], `${path}.nodes`);
    return nodes.ok
        ? success({ ruleId, actRule, wcag, impact: knownImpact, nodes: nodes.value })
        : nodes;
}

function parseJson(json: string): Read<unknown> {
    try {
        return success(JSON.parse(json));
    } catch {
        return failure({ code: AuditReportProblemCode.InvalidJson, path: "$" });
    }
}

// The failing rules, or why the report cannot be read.
export function parseAudit(json: string): Read<readonly AuditRuleResult[]> {
    const parsed = parseJson(json);
    if (!parsed.ok) {
        return parsed;
    }
    if (!Array.isArray(parsed.value)) {
        return wrongType("$");
    }
    const rules: AuditRuleResult[] = [];
    for (const [index, rule] of parsed.value.entries()) {
        const read = readRule(rule, `$[${String(index)}]`);
        if (!read.ok) {
            return read;
        }
        rules.push(read.value);
    }
    return success(rules);
}

export const toFindings = (rules: readonly AuditRuleResult[]): readonly A11yFinding[] =>
    rules.map((rule) => ({
        ruleId: rule.ruleId,
        impact: rule.impact,
        elementCount: rule.nodes.length,
    }));
