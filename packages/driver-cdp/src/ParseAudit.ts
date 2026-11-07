// Reads what pageAudit (page-audit.ts) reports from the page.
import { IMPACTS, type A11yFinding, type Box, type Impact } from "@revisum/contracts";

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

// The rule ids pageAudit implements; keep in step with it.
export const PAGE_AUDIT_RULE_IDS: readonly string[] = [
    "image-alt",
    "button-name",
    "link-name",
    "label",
    "document-title",
    "html-has-lang",
    "html-lang-valid",
    "valid-lang",
    "list",
    "autocomplete-valid",
    "color-contrast",
    "meta-viewport",
    "meta-refresh",
    "marquee",
    "aria-roles",
];

export function parseAudit(json: string): readonly AuditRuleResult[] {
    const raw = JSON.parse(json) as AuditRuleResult[];
    return raw.map((rule) => ({
        ...rule,
        impact: IMPACTS.find((impact) => impact === rule.impact) ?? "unknown",
    }));
}

export const toFindings = (rules: readonly AuditRuleResult[]): readonly A11yFinding[] =>
    rules.map((rule) => ({
        ruleId: rule.ruleId,
        impact: rule.impact,
        elementCount: rule.nodes.length,
    }));
