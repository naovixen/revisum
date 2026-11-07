// Reads what pageAudit (page-audit.ts) reports from the page. The page's own scripts may have changed
// what the browser hands back, so every field is checked and a report of any other shape is refused.
import {
    failure,
    Impact,
    IMPACTS,
    success,
    type A11yFinding,
    type Box,
    type Result,
} from "@revisum/contracts";

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

type Fields = Readonly<Record<string, unknown>>;

const fieldsOf = (value: unknown): Fields | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

// A box, null for an element with none, or undefined when the value is neither.
function readBox(value: unknown): Box | null | undefined {
    if (value === null) {
        return null;
    }
    const fields = fieldsOf(value);
    if (fields === undefined) {
        return undefined;
    }
    const { x, y, width, height } = fields;
    return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && isFiniteNumber(height)
        ? { x, y, width, height }
        : undefined;
}

function readNode(value: unknown): Result<AuditNode, string> {
    const fields = fieldsOf(value);
    if (fields === undefined) {
        return failure("a failing element is not an object");
    }
    const { selector, offscreen, snippet } = fields;
    const box = readBox(fields["box"]);
    if (
        typeof selector !== "string" ||
        box === undefined ||
        typeof offscreen !== "boolean" ||
        typeof snippet !== "string"
    ) {
        return failure("a failing element lacks its selector, box, offscreen flag or snippet");
    }
    return success({ selector, box, offscreen, snippet });
}

const isStringList = (value: unknown): value is readonly string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");

function readRule(value: unknown): Result<AuditRuleResult, string> {
    const fields = fieldsOf(value);
    if (fields === undefined) {
        return failure("a failing rule is not an object");
    }
    const { ruleId, actRule, wcag, impact, nodes } = fields;
    if (typeof ruleId !== "string") {
        return failure("a failing rule has no rule id");
    }
    if ((actRule !== null && typeof actRule !== "string") || !isStringList(wcag)) {
        return failure(`rule ${ruleId} lacks its ACT rule or its WCAG criteria`);
    }
    if (typeof impact !== "string") {
        return failure(`rule ${ruleId} has no impact`);
    }
    if (!Array.isArray(nodes)) {
        return failure(`rule ${ruleId} lists no failing elements`);
    }
    const readNodes: AuditNode[] = [];
    for (const node of nodes) {
        const read = readNode(node);
        if (!read.ok) {
            return failure(`rule ${ruleId}: ${read.error}`);
        }
        readNodes.push(read.value);
    }
    return success({
        ruleId,
        actRule,
        wcag,
        impact: IMPACTS.find((known) => known === impact) ?? Impact.Unknown,
        nodes: readNodes,
    });
}

function parseJson(json: string): Result<unknown, string> {
    try {
        return success(JSON.parse(json));
    } catch {
        return failure("the audit report is not JSON");
    }
}

// The failing rules, or why the report cannot be read.
export function parseAudit(json: string): Result<readonly AuditRuleResult[], string> {
    const parsed = parseJson(json);
    if (!parsed.ok) {
        return parsed;
    }
    if (!Array.isArray(parsed.value)) {
        return failure("the audit report is not a list of rules");
    }
    const rules: AuditRuleResult[] = [];
    for (const rule of parsed.value) {
        const read = readRule(rule);
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
